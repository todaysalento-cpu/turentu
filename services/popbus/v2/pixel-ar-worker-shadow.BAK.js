// TURENTU — percorso PIXEL-first A/R SHADOW, rigorosamente READ ONLY.
// Non modifica il worker legacy e non produce proposte attivabili.
import { leggiContestiOpportunitaPixel } from './pixel-opportunity-adapter.js';
import { generaFormazioniAlternative, valutaRichieste, verificaQualitaRichieste } from './model.js';
import { valutaEconomiaCiclo } from './cycle-pricing.js';
import { leggiRegistroAr, filtraCandidateAr } from './pixel-ar-registry.js';
import { generaFormazioniArSafe } from './pixel-ar-safe-formations.js';
import { ottimizzaFlotta } from './fleet-optimizer.ar-readonly.js';
import { eseguiPixelArShadow } from './pixel-ar-shadow-bridge.js';

const fail = m => { throw new Error('PIXEL_AR_WORKER_SHADOW: ' + m); };
const finite = x => Number.isFinite(Number(x));
export async function eseguiPixelArWorkerShadow({ pool, movement, turno, conflittiVeicolo, now = Date.now(), maxOpportunita = 100, maxProposte = 500, maxNodi = 100000 } = {}) {
  if (!pool?.connect || ![movement,turno,conflittiVeicolo].every(f => typeof f === 'function')) fail('dipendenze mancanti');
  if (![maxOpportunita,maxProposte,maxNodi].every(x => Number.isSafeInteger(x) && x > 0) || maxOpportunita >= 1000) fail('limiti non validi');
  const client = await pool.connect();
  let transaction = false;
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    transaction = true;
    // Limit + 1: vietato usare un insieme potenzialmente troncato.
    const contesti = await leggiContestiOpportunitaPixel({ client, limit: maxOpportunita + 1 });
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
    const scarti={};
    const skip=m=>{scarti[m]=(scarti[m]||0)+1;};
    for(const ctx of contesti){
      const {formazioni} = generaFormazioniArSafe({plan:ctx.plan,requests:ctx.requests,
        seeds:ctx.richiesta_ids,registro,generaFormazioniAlternative,valutaRichieste,
        maxSeeds:100,maxFormazioni:500});
      for(const evaluation of formazioni){
        if(!finite(evaluation.departure) || !finite(evaluation.arrival) ||
           evaluation.departure <= now || evaluation.departure < ctx.window.start ||
           evaluation.departure > ctx.window.end){skip('tempo');continue;}
        const selected = ctx.requests.filter(r=>evaluation.requests.some(e=>Number(e.id)===Number(r.id)));
        if(selected.length !== evaluation.requests.length || !verificaQualitaRichieste(ctx.plan,selected).ok){skip('qualita');continue;}
        for(const v of vehicles){
          if(Number(v.posti_totali)<evaluation.peak){skip('capienza');continue;}
          let approach,returnTrip;
          try{
            approach=await movement(v,nodeMap.get(Number(ctx.plan.nodes[0])));
            returnTrip=await movement(nodeMap.get(Number(ctx.plan.nodes.at(-1))),v);
            if(![approach.metres,approach.seconds,returnTrip.metres,returnTrip.seconds].every(x=>finite(x)&&Number(x)>=0)) throw Error('routing');
          } catch (err) {
            skip('routing');
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
          if(busyStart<=now || !turno(v,busyStart,busyEnd)){skip('turno');continue;}
          if((await conflittiVeicolo(client,v.id,busyStart,busyEnd)).length){skip('conflitto');continue;}
          let economia;
          try{
            economia=valutaEconomiaCiclo({ricaviRichiesteEuro:selected.map(r=>Number(r.prezzo)),
              kmAvvicinamento:Number(approach.metres)/1000,
              kmMissioni:ctx.plan.legs.reduce((s,l)=>s+Number(l.metres),0)/1000,
              kmTrasferimenti:0,kmRitornoBase:Number(returnTrip.metres)/1000,
              euroKm:Number(v.euro_km)});
            if(!finite(economia.margineEuro)) throw Error('margine');
          }catch{skip('economia');continue;}
          // NON filtrare per economicamenteAttivabile: l'A/R e' globale.
          if(proposte.length >= maxProposte) fail('proposte oltre limite: nessun troncamento');
          proposte.push({veicolo:Number(v.id),richieste:evaluation.requests.map(r=>Number(r.id)),
            partenza_base:busyStart,ritorno_base:busyEnd,
            margine_ciclo_con_attesa_euro:Number(economia.margineEuro),
            _economiaRicalcolata:true,_pixelOpportunitaIds:[ctx.pixel_opportunita_id],
            _shadow:{plan:ctx.plan,evaluation,vehicle:v,approach,returnTrip,economia}});
        }
      }
    }
    const result=await eseguiPixelArShadow({client,contesti,proposte,
      leggiRegistroAr,filtraCandidateAr,ottimizzaFlotta,
      maxCandidati:maxProposte,maxNodi});
    // Una ricerca limitata per nodi non e' una prova di ottimalita: fail-closed.
    if(result.scelta.limiteNodiRaggiunto || result.scelta.candidatiTagliati || result.scelta.ottimoDimostrato===false)
      fail('ottimizzazione incompleta');
    return {passed:true,shadow:true,dbWrites:0,opportunita:contesti.length,
      veicoli:vehicles.length,proposte:proposte.length,scarti,
      ...result.diagnostica,scelta:{margineTotaleEuro:result.scelta.margineTotaleEuro,
        richiesteIds:result.scelta.richiesteIds,
        selezionati:result.scelta.selezionati.map(c=>({veicolo:c.veicolo,richieste:c.richieste,
          margineEuro:c.margine_ciclo_con_attesa_euro}))}};
  } finally {
    try { if(transaction) await client.query('ROLLBACK'); } finally { client.release(); }
  }
}
