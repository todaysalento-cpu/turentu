// TURENTU ÔÇö percorso PIXEL-first A/R SHADOW, rigorosamente READ ONLY.
// Non modifica il worker legacy e non produce proposte attivabili.
import { leggiContestiOpportunitaPixel } from './pixel-opportunity-adapter.js';
import { generaFormazioniAlternative, valutaRichieste, verificaQualitaRichieste } from './model.js';
import { valutaEconomiaCiclo } from './cycle-pricing.js';
import { leggiRegistroAr, filtraCandidateAr } from './pixel-ar-registry.js';
import { generaFormazioniArSafe } from './pixel-ar-safe-formations.js';
import { ottimizzaFlotta } from './fleet-optimizer.ar-readonly.js';
import { eseguiPixelArShadow } from './pixel-ar-shadow-bridge.js';
import { generaCicliDueMissioniShadow } from './pixel-multimission-shadow.js';
import { analizzaCoppieMultiMissione } from './pixel-multimission-preflight.js';

const fail = m => { throw new Error('PIXEL_AR_WORKER_SHADOW: ' + m); };
const finite = x => Number.isFinite(Number(x));
export async function eseguiPixelArWorkerShadow({ pool, client: externalClient = null, movement, turno, conflittiVeicolo, now = Date.now(), maxOpportunita = 100, maxProposte = 2000, maxNodi = 100000,
  enableMultiMission = false, preflightMultiMission = false, maxPreflightChecks = 2000000, maxPairs = 2000, maxRoutingCalls = 100, costoAttesaOraEuro = 0, opportunityIds = null } = {}) {
  if ((!externalClient?.query && !pool?.connect) || (externalClient !== null && typeof externalClient.query !== 'function') || (!preflightMultiMission && ![movement,turno,conflittiVeicolo].every(f => typeof f === 'function'))) fail('dipendenze mancanti');
  if (preflightMultiMission && !enableMultiMission) fail('preflight richiede enableMultiMission');
  if (![maxOpportunita,maxProposte,maxNodi].every(x => Number.isSafeInteger(x) && x > 0) || maxOpportunita >= 1000) fail('limiti non validi');
  if (!Number.isSafeInteger(maxRoutingCalls) || maxRoutingCalls < 1) fail('maxRoutingCalls non valido');
  // Cache locale per questa esecuzione shadow, condivisa tra singole e multi.
  // Conta invocazioni al movement sottostante (non necessariamente HTTP: planner.leg ha una propria cache).
  const routingCache = new Map();
  const routingBudget = {
    limite: maxRoutingCalls, chiamateEffettive: 0, richieste: 0, cacheHit: 0,
    erroriRouting: 0,
    perFase: {
      singole: { richieste: 0, chiamateEffettive: 0, cacheHit: 0, erroriRouting: 0 },
      multi: { richieste: 0, chiamateEffettive: 0, cacheHit: 0, erroriRouting: 0 }
    }
  };
  let routingFase = 'singole';
  const snapshotRouting = () => ({
    ...routingBudget,
    residue: Math.max(0, routingBudget.limite - routingBudget.chiamateEffettive),
    cacheEntries: routingCache.size,
    fase: routingFase
  });
  const budgetedMovement = async (from, to) => {
    const fase = routingBudget.perFase[routingFase];
    routingBudget.richieste++;
    fase.richieste++;
    const coords = [from?.lat, from?.lon, to?.lat, to?.lon].map(Number);
    // Fail closed: non creare chiavi di cache ambigue per coordinate assenti.
    if (coords.some(x => !Number.isFinite(x)) ||
        Math.abs(coords[0]) > 90 || Math.abs(coords[2]) > 90 ||
        Math.abs(coords[1]) > 180 || Math.abs(coords[3]) > 180) {
      throw new Error('PIXEL_AR_WORKER_SHADOW: coordinate routing non valide');
    }
    const key = `${coords[0]},${coords[1]}>${coords[2]},${coords[3]}`;
    if (routingCache.has(key)) {
      routingBudget.cacheHit++;
      fase.cacheHit++;
      return routingCache.get(key);
    }
    if (routingBudget.chiamateEffettive >= routingBudget.limite) {
      const err = new Error('PIXEL_AR_WORKER_SHADOW: budget routing globale esaurito (' +
        routingBudget.chiamateEffettive + '/' + routingBudget.limite +
        '), fase=' + routingFase + ', nessun risultato parziale');
      err.code = 'PIXEL_SHADOW_ROUTING_BUDGET_EXCEEDED';
      throw err;
    }
    routingBudget.chiamateEffettive++;
    fase.chiamateEffettive++;
    try {
      const route = await movement(from, to);
      if (!route || !Number.isFinite(Number(route.metres)) ||
          !Number.isFinite(Number(route.seconds)) ||
          Number(route.metres) < 0 || Number(route.seconds) < 0) {
        throw new Error('Routing incompleto: metres/seconds non validi');
      }
      routingCache.set(key, route); // Mai memorizzare errori o percorsi incompleti.
      return route;
    } catch (err) {
      routingBudget.erroriRouting++;
      fase.erroriRouting++;
      throw err;
    }
  };
  const ownsTransaction = externalClient === null;
  const client = ownsTransaction ? await pool.connect() : externalClient;
  let transaction = false;
  try {
    if (ownsTransaction) {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      transaction = true;
    }
    // Limit + 1: vietato usare un insieme potenzialmente troncato.
    const contesti = await leggiContestiOpportunitaPixel({ client, limit: maxOpportunita + 1, opportunityIds });
    if (contesti.length > maxOpportunita) fail('opportunita oltre limite: nessun troncamento');
    const allIds = [...new Set(contesti.flatMap(c => c.richiesta_ids.map(Number)))];
    const registro = await leggiRegistroAr({ client, richiestaIds: allIds });
    const nodeIds = [...new Set(contesti.flatMap(c => c.plan.nodes.map(Number)))];
    const {rows: nodes} = await client.query(`SELECT id, nome AS nome_nodo,
      ST_Y(posizione::geometry) AS lat, ST_X(posizione::geometry) AS lon
      FROM public.nodi_territoriali WHERE id=ANY($1::bigint[]) AND attivo=TRUE`,[nodeIds]);
    if (nodes.length !== nodeIds.length) fail('nodi territoriali assenti o inattivi');
    const nodeMap = new Map(nodes.map(n=>[Number(n.id),n]));
    const {rows: vehicles} = await client.query(`SELECT v.id,v.driver_id,v.posti_totali,t.euro_km,
      dv.start,dv.fine,dv.manual,dv.giorni_esclusi,dv.inattivita,
      ST_Y(COALESCE(dv.coord,v.coord)::geometry) AS lat,
      ST_X(COALESCE(dv.coord,v.coord)::geometry) AS lon
      FROM veicolo v JOIN disponibilita_veicolo dv ON dv.veicolo_id=v.id
      JOIN LATERAL (SELECT MIN(euro_km) AS euro_km FROM tariffe
        WHERE veicolo_id=v.id AND tipo='standard' AND euro_km>0) t ON t.euro_km IS NOT NULL
      WHERE v.driver_id IS NOT NULL AND v.posti_totali>0
        AND COALESCE(dv.coord,v.coord) IS NOT NULL ORDER BY t.euro_km,v.id`);
    const proposte=[];
    const missioniMulti=[];
    const missionKeys=new Set();
    const scarti={};
    const skip=m=>{scarti[m]=(scarti[m]||0)+1;};
    const diagnosticaOpportunita=[];
    for(const ctx of contesti){
      const diagnosticaCtx={
        opportunita:Number(ctx.pixel_opportunita_id),
        richieste:ctx.richiesta_ids.map(Number),
        formazioniGenerate:0,formazioniTempoValide:0,formazioniQualitaValide:0,
        scarti:{},proposteGenerate:0,
        esempiFormazioni:[]
      };
      const skipCtx=motivo=>{
        skip(motivo);
        diagnosticaCtx.scarti[motivo]=(diagnosticaCtx.scarti[motivo]||0)+1;
      };
      const {formazioni} = generaFormazioniArSafe({plan:ctx.plan,requests:ctx.requests,
        seeds:ctx.richiesta_ids,registro,generaFormazioniAlternative,valutaRichieste,
        maxSeeds:100,maxFormazioni:500});
      diagnosticaCtx.esempiScartiOperativi=[];
      diagnosticaCtx.formazioniGenerate=formazioni.length;
      for(const evaluation of formazioni){
        if(diagnosticaCtx.esempiFormazioni.length<5){
          diagnosticaCtx.esempiFormazioni.push({
            richieste:(evaluation.requests||[]).map(r=>Number(r.id)),
            partenza:evaluation.departure,arrivo:evaluation.arrival,
            windowStart:ctx.window.start,windowEnd:ctx.window.end,
            peak:evaluation.peak
          });
        }
        if(!finite(evaluation.departure) || !finite(evaluation.arrival) ||
           evaluation.departure <= now || evaluation.departure < ctx.window.start ||
           evaluation.departure > ctx.window.end){skipCtx('tempo');continue;}
        diagnosticaCtx.formazioniTempoValide++;
        const selected = ctx.requests.filter(r=>evaluation.requests.some(e=>Number(e.id)===Number(r.id)));
        if(selected.length !== evaluation.requests.length || !verificaQualitaRichieste(ctx.plan,selected).ok){skipCtx('qualita');continue;}
        diagnosticaCtx.formazioniQualitaValide++;
        // Formazione validata indipendentemente dal ciclo base->missione->base:
        // puo' essere fattibile solo in concatenazione con un'altra missione.
        const missionKey=String(ctx.pixel_opportunita_id)+':'+selected.map(r=>Number(r.id)).sort((a,b)=>a-b).join(',');
        if (enableMultiMission && !missionKeys.has(missionKey)) {
          missionKeys.add(missionKey);
          const first=nodeMap.get(Number(ctx.plan.nodes[0]));
          const last=nodeMap.get(Number(ctx.plan.nodes.at(-1)));
          if (!first || !last) fail('estremi missione non trovati');
          missioniMulti.push({
            pixelOpportunitaId:Number(ctx.pixel_opportunita_id),
            from:first,to:last,
            departure:Number(evaluation.departure),arrival:Number(evaluation.arrival),
            kmMissione:ctx.plan.legs.reduce((s,l)=>s+Number(l.metres),0)/1000,
            peak:Number(evaluation.peak),
            requests:selected.map(r=>({id:Number(r.id),prezzo:Number(r.prezzo)}))
          });
        }
        if (preflightMultiMission) continue; // Preflight: niente routing delle missioni singole.
        for(const v of vehicles){
          if(Number(v.posti_totali)<evaluation.peak){skipCtx('capienza');continue;}
          let approach,returnTrip;
          try{
            approach=await budgetedMovement(v,nodeMap.get(Number(ctx.plan.nodes[0])));
            returnTrip=await budgetedMovement(nodeMap.get(Number(ctx.plan.nodes.at(-1))),v);
            if(![approach.metres,approach.seconds,returnTrip.metres,returnTrip.seconds].every(x=>finite(x)&&Number(x)>=0)) throw Error('routing');
          } catch (err) {
            if (err?.code === 'PIXEL_SHADOW_ROUTING_BUDGET_EXCEEDED') throw err;
            skipCtx('routing');
            // Diagnostica limitata: nessuna modifica al matching o al database.
            if (scarti.routing <= 5) {
              console.error('[PIXEL AR ROUTING DIAGNOSTIC]', {
                opportunita: ctx.pixel_opportunita_id,
                veicolo: v.id,
                nodoIniziale: ctx.plan.nodes[0],
                nodoFinale: ctx.plan.nodes.at(-1),
                veicoloCoordinateValide: finite(v.lat) && finite(v.lon),
                nodoInizialePresente: nodeMap.has(Number(ctx.plan.nodes[0])),
                nodoFinalePresente: nodeMap.has(Number(ctx.plan.nodes.at(-1))),
                approach: approach && { metres: approach.metres, seconds: approach.seconds },
                returnTrip: returnTrip && { metres: returnTrip.metres, seconds: returnTrip.seconds },
                errore: err?.message ?? String(err)
              });
            }
            continue;
          }
          const busyStart=evaluation.departure-Number(approach.seconds)*1000;
          const busyEnd=evaluation.arrival+Number(returnTrip.seconds)*1000;
          // Diagnostica separata: conserva esattamente le stesse condizioni di esclusione.
          // Il turno viene interrogato solo se busyStart > now, come nel controllo originale.
          if(busyStart<=now){
            skipCtx('avvicinamento_passato');
            if(diagnosticaCtx.esempiScartiOperativi.length<12)
              diagnosticaCtx.esempiScartiOperativi.push({motivo:'avvicinamento_passato',
                veicolo:Number(v.id),richieste:selected.map(r=>Number(r.id)),
                partenza:evaluation.departure,arrivo:evaluation.arrival,
                busyStart,busyEnd,now,secondiAvvicinamento:Number(approach.seconds),
                disponibilita:{start:v.start,fine:v.fine,manual:v.manual}});
            continue;
          }
          if(!turno(v,busyStart,busyEnd)){
            skipCtx('turno');
            if(diagnosticaCtx.esempiScartiOperativi.length<12)
              diagnosticaCtx.esempiScartiOperativi.push({motivo:'turno',
                veicolo:Number(v.id),richieste:selected.map(r=>Number(r.id)),
                partenza:evaluation.departure,arrivo:evaluation.arrival,
                busyStart,busyEnd,now,secondiAvvicinamento:Number(approach.seconds),
                disponibilita:{start:v.start,fine:v.fine,manual:v.manual,
                  giorni_esclusi:v.giorni_esclusi,inattivita:v.inattivita}});
            continue;
          }
          if((await conflittiVeicolo(client,v.id,busyStart,busyEnd)).length){skipCtx('conflitto');continue;}
          let economia;
          try{
            economia=valutaEconomiaCiclo({ricaviRichiesteEuro:selected.map(r=>Number(r.prezzo)),
              kmAvvicinamento:Number(approach.metres)/1000,
              kmMissioni:ctx.plan.legs.reduce((s,l)=>s+Number(l.metres),0)/1000,
              kmTrasferimenti:0,kmRitornoBase:Number(returnTrip.metres)/1000,
              euroKm:Number(v.euro_km)});
            if(!finite(economia.margineEuro)) throw Error('margine');
          }catch{skipCtx('economia');continue;}
          // NON filtrare per economicamenteAttivabile: l'A/R e' globale.
          if(proposte.length >= maxProposte) fail('proposte oltre limite: nessun troncamento');
          diagnosticaCtx.proposteGenerate++;
          proposte.push({veicolo:Number(v.id),richieste:evaluation.requests.map(r=>Number(r.id)),
            partenza_base:busyStart,ritorno_base:busyEnd,
            margine_ciclo_con_attesa_euro:Number(economia.margineEuro),
            _economiaRicalcolata:true,_pixelOpportunitaIds:[ctx.pixel_opportunita_id],
            _shadow:{plan:ctx.plan,evaluation,vehicle:v,approach,returnTrip,economia}});
        }
      }
      diagnosticaOpportunita.push(diagnosticaCtx);
      console.log('PIXEL_AR_OPPORTUNITA_DIAGNOSTIC:'+JSON.stringify(diagnosticaCtx));
    }
    // Modalita' opt-in: ciclo di due opportunita PIXEL gia' validate.
    // Le missioni sono raccolte PRIMA dei filtri economici del ciclo singolo.
    // Il bridge verifica provenienza e vincoli A/R sull'insieme delle candidate.
    // Preflight prioritario: formazioni PIXEL validate, nessuna chiamata routing.
    // Ritorna prima della generazione dei cicli e dell'ottimizzazione.
    if (preflightMultiMission) {
      const risultatoPreflight = analizzaCoppieMultiMissione({
        missions: missioniMulti,
        vehicles,
        now,
        maxChecks: maxPreflightChecks
      });
      console.log('PIXEL_MULTIMISSION_PREFLIGHT_JSON:' + JSON.stringify(risultatoPreflight));
      return risultatoPreflight;
    }
    let diagnosticaMulti={abilitato:enableMultiMission,missioni:missioniMulti.length,cicli:0,coppieTentate:0};
    if (enableMultiMission) {
      routingFase = 'multi';
      if (!Number.isSafeInteger(maxPairs) || maxPairs<1) fail('maxPairs invalido');
      const multi=await generaCicliDueMissioniShadow({
        missions:missioniMulti,
        vehicles:vehicles.map(v=>({
          ...v, id:Number(v.id),lat:Number(v.lat),lon:Number(v.lon),
          euroKm:Number(v.euro_km),posti_totali:Number(v.posti_totali)
        })),
        movement:budgetedMovement,
        isAvailable:async(v,start,end)=>Boolean(await turno(v,start,end)),
        hasConflicts:async(v,start,end)=>(await conflittiVeicolo(client,v.id,start,end)).length>0,
        // Il limite effettivo e condiviso e applicato da budgetedMovement.
        // Il contatore interno del generatore include anche cache hit della cache condivisa.
        now,maxPairs,maxRoutingCalls:Number.MAX_SAFE_INTEGER,costoAttesaOraEuro
      });
      diagnosticaMulti={abilitato:true,missioni:missioniMulti.length,
        cicli:multi.cicli.length,coppieTentate:multi.attempted,
        routingStats:multi.routingStats};
      if(proposte.length+multi.cicli.length>maxProposte)
        fail('proposte singole + multi oltre limite: nessun troncamento');
      proposte.push(...multi.cicli);
      console.log('PIXEL_AR_MULTIMISSION_DIAGNOSTIC:'+JSON.stringify(diagnosticaMulti));
    }
    // Diagnostica economica aggregata: non modifica candidati, soglie o ottimizzazione.
    const margini = proposte
      .map(p => Number(p.margine_ciclo_con_attesa_euro))
      .filter(Number.isFinite);
    const positivi = margini.filter(m => m > 0).length;
    const negativi = margini.filter(m => m < 0).length;
    const zero = margini.filter(m => m === 0).length;
    const sommaMargini = margini.reduce((somma, m) => somma + m, 0);
    console.log('PIXEL_AR_ECONOMIA_DIAGNOSTIC:' + JSON.stringify({
      totale: margini.length,
      positivi,
      negativi,
      zero,
      margineMinimo: margini.length ? Math.min(...margini) : null,
      margineMassimo: margini.length ? Math.max(...margini) : null,
      margineMedio: margini.length ? sommaMargini / margini.length : null
    }));
    // Dettaglio economico degli estremi: sola diagnostica, nessuna modifica alle proposte.
    const ordinate = [...proposte].sort((a, b) =>
      b.margine_ciclo_con_attesa_euro - a.margine_ciclo_con_attesa_euro);
    for (const [tipo, p] of [
      ['MIGLIORE', ordinate[0]],
      ['PEGGIORE', ordinate.at(-1)]
    ]) {
      if (!p) continue;
      const shadow = p._shadow || {};
      const multi = Array.isArray(shadow.missions);
      const requestPrices = new Map();
      for (const ctx of contesti) {
        for (const r of ctx.requests || []) {
          const id = Number(r.id);
          const price = Number(r.prezzo);
          if (Number.isFinite(price) && price >= 0) requestPrices.set(id, price);
        }
      }
      const richiesteDettaglio = p.richieste.map(id => ({
        id: Number(id),
        prezzoNumerico: requestPrices.get(Number(id)) ?? null
      }));
      const ricaviCompleti = richiesteDettaglio.every(r => r.prezzoNumerico !== null);
      const veicoloOrigine = shadow.vehicle || vehicles.find(v => Number(v.id) === Number(p.veicolo));
      const kmMissione = multi
        ? shadow.missions.reduce((sum, m) => sum + Number(m.kmMissione), 0)
        : shadow.plan?.legs?.reduce((sum, leg) => sum + Number(leg.metres), 0) / 1000;
      console.log('PIXEL_AR_DETTAGLIO_ECONOMICO:' + JSON.stringify({
        tipo,
        opportunita: p._pixelOpportunitaIds,
        veicolo: p.veicolo,
        richieste: p.richieste,
        margineEuro: p.margine_ciclo_con_attesa_euro,
        tipoCiclo: multi ? 'MULTIMISSIONE' : 'SINGOLA',
        euroKm: veicoloOrigine ? Number(veicoloOrigine.euro_km ?? veicoloOrigine.euroKm) : null,
        ricaviRichieste: richiesteDettaglio,
        ricaviTotaliEuro: ricaviCompleti
          ? richiesteDettaglio.reduce((sum, r) => sum + r.prezzoNumerico, 0) : null,
        kmAvvicinamento: Number(shadow.approach?.metres) / 1000,
        kmMissione: Number.isFinite(kmMissione) ? kmMissione : null,
        kmTrasferimento: multi ? Number(shadow.transfer?.metres) / 1000 : 0,
        kmRitorno: Number(shadow.returnTrip?.metres) / 1000,
        oreAttesa: multi ? shadow.waitingHours : 0,
        economia: shadow.economia
      }));
    }
    // Diagnostica sola lettura: proposte effettivamente inviate al bridge A/R.
    // Non altera candidate, filtri, soglie, ordinamento o ottimizzazione.
    const diagnosticaProposteAr = proposte.map(p => ({
      veicolo: p.veicolo,
      richieste: p.richieste,
      opportunita: p._pixelOpportunitaIds,
      margine: p.margine_ciclo_con_attesa_euro,
      busyStart: p.partenza_base,
      busyEnd: p.ritorno_base
    }));
    console.log('PIXEL_AR_PROPOSTE_DIAGNOSTIC:' + JSON.stringify(diagnosticaProposteAr));
    const result=await eseguiPixelArShadow({client,contesti,proposte,
      leggiRegistroAr,filtraCandidateAr,ottimizzaFlotta,
      maxCandidati:maxProposte,maxNodi});
    // Una ricerca limitata per nodi non e' una prova di ottimalita: fail-closed.
    if(result.scelta.limiteNodiRaggiunto || result.scelta.candidatiTagliati || result.scelta.ottimoDimostrato===false)
      fail('ottimizzazione incompleta');
    console.log('PIXEL_AR_ROUTING_BUDGET_JSON:' + JSON.stringify(snapshotRouting()));
    return {passed:true,shadow:true,dbWrites:0,routingBudget:snapshotRouting(),opportunita:contesti.length,
      veicoli:vehicles.length,proposte:proposte.length,scarti,multiMission:diagnosticaMulti,
      ...result.diagnostica,scelta:{margineTotaleEuro:result.scelta.margineTotaleEuro,
        richiesteIds:result.scelta.richiesteIds,
        selezionati:result.scelta.selezionati.map(c=>({veicolo:c.veicolo,richieste:c.richieste,
          margineEuro:c.margine_ciclo_con_attesa_euro}))}};
  } catch (err) {
    console.error('PIXEL_AR_ROUTING_BUDGET_DIAGNOSTIC:' + JSON.stringify({
      passed:false, shadow:true, dbWrites:0, errore:err?.code || err?.message,
      routingBudget:snapshotRouting()
    }));
    throw err;
  } finally {
    if (ownsTransaction) {
      try { if (transaction) await client.query('ROLLBACK'); } finally { client.release(); }
    }
  }
}
