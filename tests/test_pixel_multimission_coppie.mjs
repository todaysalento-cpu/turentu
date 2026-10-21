// TURENTU POPBUS V2 - Diagnostica coppie PIXEL -> POPBUS -> Shadow, SOLO LETTURA.
// Copiare in tests/test_pixel_multimission_coppie.mjs
// Eseguire: node --env-file=.env tests\test_pixel_multimission_reale.mjs
import { pool } from '../db/db.js';
import { leggiContestiOpportunitaPixel } from '../services/popbus/v2/pixel-opportunity-adapter.js';
import { generaFormazioniAlternative, verificaQualitaRichieste } from '../services/popbus/v2/model.js';
import { leg } from '../services/popbus/v2/planner.js';
import { verificaTurnoVeicolo } from '../services/popbus/v2/popbus-vehicle-availability.js';
import { anteprimaCicliMultimissione } from '../services/popbus/v2/formation-multimission-preview.js';

const OPPORTUNITA = [115,116,117,118,119,120];
const VEICOLO_ID = 361;
const MAX_FORM_PER_SEED = 12;
const MAX_MISSIONI = 180;
const MAX_COPPIE = 12000;
const MAX_ROUTING = 100;
const positive = x => Number.isSafeInteger(Number(x)) && Number(x) > 0;
const same = (a,b) => Math.abs(Number(a.lat)-Number(b.lat))<1e-7 && Math.abs(Number(a.lon)-Number(b.lon))<1e-7;
const linked = r => r.ar_vincolata===true || r.ar_vincolata==='true' || r.ar_group_id!=null;

async function conflicts(client, vehicleId, start, end) {
  const {rows} = await client.query(`
    SELECT 1 FROM public.popbus_attivazioni a
    WHERE a.veicolo_id=$1 AND a.stato IN ('in_attesa_autista','confermata')
      AND COALESCE((a.piano->>'busyStart')::timestamptz,a.partenza) < $3
      AND COALESCE((a.piano->>'busyEnd')::timestamptz,a.arrivo) > $2
    UNION ALL
    SELECT 1 FROM public.corse c
    WHERE c.veicolo_id=$1 AND c.stato IN ('prenotabile','in_corso','da_attivare')
      AND c.start_datetime < $3
      AND (c.arrivo_datetime IS NULL OR c.arrivo_datetime > $2)
    UNION ALL
    SELECT 1 FROM public.direttrici_virtuali d
    JOIN public.segmenti s ON s.direttrice_id=d.id
    WHERE d.veicolo_id=$1 AND d.stato IN ('in_attesa_autista','attivo','confermata')
      AND d.partenza_prevista < $3
      AND NOT EXISTS (
        SELECT 1 FROM public.popbus_attivazioni a
        WHERE a.direttrice_id=d.id AND a.veicolo_id=d.veicolo_id
          AND a.stato IN ('in_attesa_autista','confermata'))
    GROUP BY d.id,d.partenza_prevista
    HAVING MAX(s.start_datetime+s.tempo_stimato*INTERVAL '1 minute') > $2
    LIMIT 1`, [vehicleId,new Date(start),new Date(end)]);
  return rows.length > 0;
}

const client = await pool.connect();
let transaction = false;
try {
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  transaction = true;
  const contexts = await leggiContestiOpportunitaPixel({client,limit:OPPORTUNITA.length+1,opportunityIds:OPPORTUNITA});
  if (contexts.length > OPPORTUNITA.length) throw new Error('Opportunita oltre limite');
  const present = new Set(contexts.map(c=>Number(c.pixel_opportunita_id)));
  const missing = OPPORTUNITA.filter(id=>!present.has(id));
  console.log('PIXEL',JSON.stringify({opportunita_lette:contexts.map(c=>c.pixel_opportunita_id),opportunita_assenti:missing}));
  if (!contexts.length) throw new Error('Nessuna opportunita PIXEL leggibile');
  const nodeIds = [...new Set(contexts.flatMap(c=>c.plan.nodes.map(Number)))];
  const {rows:nodes} = await client.query(`SELECT id,ST_Y(posizione::geometry) AS lat,ST_X(posizione::geometry) AS lon
    FROM public.nodi_territoriali WHERE attivo=TRUE AND id=ANY($1::bigint[])`,[nodeIds]);
  if (nodes.length !== nodeIds.length) throw new Error('Nodi territoriali mancanti o inattivi');
  const byNode = new Map(nodes.map(n=>[Number(n.id),n]));
  const {rows:vehicles} = await client.query(`
    SELECT v.id,v.driver_id,v.stato,v.posti_totali,t.euro_km,
      dv.start,dv.fine,dv.manual,dv.giorni_esclusi,dv.inattivita,
      ST_Y(COALESCE(dv.coord,v.coord)::geometry) AS lat,
      ST_X(COALESCE(dv.coord,v.coord)::geometry) AS lon
    FROM public.veicolo v
    JOIN public.disponibilita_veicolo dv ON dv.veicolo_id=v.id
    JOIN LATERAL (SELECT MIN(euro_km) AS euro_km FROM public.tariffe
      WHERE veicolo_id=v.id AND tipo='standard' AND euro_km>0) t ON t.euro_km IS NOT NULL
    WHERE v.id=$1 AND v.driver_id IS NOT NULL AND v.posti_totali>0
      AND COALESCE(dv.coord,v.coord) IS NOT NULL`,[VEICOLO_ID]);
  if (vehicles.length!==1) throw new Error(`Veicolo ${VEICOLO_ID}: attesa una disponibilita valida, trovate ${vehicles.length}`);
  const vehicle=vehicles[0];
  console.log('VEICOLO',JSON.stringify({id:vehicle.id,stato:vehicle.stato,posti:vehicle.posti_totali,euro_km:vehicle.euro_km}));
  const missions=[];
  const seen=new Set();
  const diag=[];
  for (const ctx of contexts) {
    // Solo STANDARD e non A/R. Nessuna richiesta sintetica in questa prova.
    const requests=ctx.requests.filter(r=>r.classe==='STANDARD' && !linked(r));
    let count=0;
    for (const seed of requests) {
      const alternatives=generaFormazioniAlternative(ctx.plan,requests,[Number(seed.id)],{
        departureWindow:ctx.window,maxFormazioni:MAX_FORM_PER_SEED
      });
      for (const evaluation of alternatives) {
        const ids=evaluation.requests.map(r=>Number(r.id));
        const key=`${ctx.pixel_opportunita_id}|${ids.slice().sort((a,b)=>a-b).join(',')}|${evaluation.departure}`;
        if (seen.has(key)) continue;
        const selected= requests.filter(r=>ids.includes(Number(r.id)));
        if (selected.length!==ids.length || !verificaQualitaRichieste(ctx.plan,selected).ok)
          throw new Error(`Qualita o selezione incoerente: opportunita ${ctx.pixel_opportunita_id}`);
        if (evaluation.departure<ctx.window.start || evaluation.departure>ctx.window.end)
          throw new Error('Partenza fuori finestra PIXEL');
        const first=byNode.get(Number(ctx.plan.nodes[0]));
        const last=byNode.get(Number(ctx.plan.nodes.at(-1)));
        const kmMissione=ctx.plan.legs.reduce((sum,l)=>sum+Number(l.metres),0)/1000;
        if (!first || !last || !(kmMissione>0)) throw new Error('Geometria missione non valida');
        seen.add(key);
        missions.push({
          pixelOpportunitaId:Number(ctx.pixel_opportunita_id),
          from:{lat:Number(first.lat),lon:Number(first.lon)},
          to:{lat:Number(last.lat),lon:Number(last.lon)},
          departure:Number(evaluation.departure),arrival:Number(evaluation.arrival),
          kmMissione,peak:Number(evaluation.peak),
          requests:selected.map(r=>({id:Number(r.id),prezzo:Number(r.prezzo)})),
          validated:true
        });
        count++;
        if (missions.length>MAX_MISSIONI) throw new Error('Budget missioni esaurito: nessun risultato parziale');
      }
    }
    diag.push({opportunita:ctx.pixel_opportunita_id,richieste_standard:requests.length,formazioni:count});
  }
  console.log('FORMAZIONI',JSON.stringify(diag,null,2));
  if (!missions.length) {
    console.log('NESSUNA FORMAZIONE: nessun ciclo valutabile');
  } else {
    const routingCache=new Map();
    let routingEffettivo=0;
    const movement=async(a,b)=>{
      if(same(a,b)) return {metres:0,seconds:0};
      const key=`${Number(a.lat)},${Number(a.lon)}>${Number(b.lat)},${Number(b.lon)}`;
      if(!routingCache.has(key)) {
        routingEffettivo++;
        const result=await leg(a,b);
        if(!result || !Number.isFinite(Number(result.metres)) || !Number.isFinite(Number(result.seconds)) ||
           Number(result.metres)<0 || Number(result.seconds)<0) throw new Error('Routing reale non valido');
        routingCache.set(key,result);
      }
      return routingCache.get(key);
    };
    const result=await anteprimaCicliMultimissione({
      missions,
      vehicles:[{id:Number(vehicle.id),lat:Number(vehicle.lat),lon:Number(vehicle.lon),
        euroKm:Number(vehicle.euro_km),posti_totali:Number(vehicle.posti_totali)}],
      movement,
      isAvailable:async(_v,a,b)=>verificaTurnoVeicolo(vehicle,a,b),
      hasConflicts:async(_v,a,b)=>conflicts(client,Number(vehicle.id),a,b),
      // Tutte le richieste incluse sono STANDARD e non A/R; coppie con ID
      // duplicati sono rifiutate anche dall'orchestratore e dallo Shadow.
      validatePair:async(a,b)=>a.requests.every(r=>positive(r.id)) && b.requests.every(r=>positive(r.id)),
      maxPairs:MAX_COPPIE,maxRoutingCalls:MAX_ROUTING,
      costoAttesaOraEuro:Number(process.env.POPBUS_PIXEL_COSTO_ATTESA_ORA_EURO || 0),
      altriCostiEuro:Number(process.env.POPBUS_PIXEL_ALTRI_COSTI_EURO || 0),
      margineMinimoEuro:Number(process.env.POPBUS_PIXEL_MARGINE_MINIMO_EURO || 0)
    });
    // Diagnostica esaustiva sulle coppie delle formazioni FORNITE (non su tutte le formazioni teoriche).
    const stats=new Map();
    const get=(a,b)=>{
      const k=`${a}->${b}`;
      if(!stats.has(k)) stats.set(k,{coppia:k,prima:a,seconda:b,combinazioni:0,
        richieste_sovrapposte:0,ordine_temporale_impossibile:0,
        capienza_incompatibile:0,ammissibili_pre_shadow:0,
        cicli_fattibili:0,margine_massimo:null,ricavo_massimo:null,
        costo_minimo:null,deficit_minimo:null,migliore:null});
      return stats.get(k);
    };
    for(const a of missions) for(const b of missions) {
      if(a===b) continue;
      const st=get(a.pixelOpportunitaId,b.pixelOpportunitaId);
      st.combinazioni++;
      if(a.arrival>b.departure) {st.ordine_temporale_impossibile++;continue;}
      const ids=new Set(a.requests.map(r=>r.id));
      if(b.requests.some(r=>ids.has(r.id))) {st.richieste_sovrapposte++;continue;}
      if(a.peak>Number(vehicle.posti_totali)||b.peak>Number(vehicle.posti_totali)) {
        st.capienza_incompatibile++;continue;
      }
      st.ammissibili_pre_shadow++;
    }
    for(const c of result.cicli) {
      const [a,b]=c.pixel_opportunita_ids;
      const st=get(a,b);
      st.cicli_fattibili++;
      st.margine_massimo=Math.max(st.margine_massimo??-Infinity,c.margine_euro);
      st.ricavo_massimo=Math.max(st.ricavo_massimo??-Infinity,c.ricavo_lordo_euro);
      st.costo_minimo=Math.min(st.costo_minimo??Infinity,c.costo_completo_euro);
      st.deficit_minimo=Math.min(st.deficit_minimo??Infinity,c.deficit_lordo_euro);
      if(!st.migliore || c.margine_euro>st.migliore.margine_euro ||
          (c.margine_euro===st.migliore.margine_euro && c.deficit_lordo_euro<st.migliore.deficit_lordo_euro)) {
        st.migliore={opportunita:c.pixel_opportunita_ids,richieste:c.richiesta_ids,
          ricavo_lordo_euro:c.ricavo_lordo_euro,costo_completo_euro:c.costo_completo_euro,
          soglia_lorda_euro:c.soglia_attivazione_lorda_euro,
          margine_euro:c.margine_euro,deficit_lordo_euro:c.deficit_lordo_euro,
          km_avvicinamento:c.km_avvicinamento,km_missioni:c.km_missioni,
          km_trasferimento:c.km_trasferimento,km_ritorno:c.km_ritorno,
          partenza_base:c.partenza_base,ritorno_base:c.ritorno_base};
      }
    }
    const rows=[...stats.values()].filter(s=>s.combinazioni>0)
      .sort((a,b)=>b.cicli_fattibili-a.cicli_fattibili ||
        (b.margine_massimo??-Infinity)-(a.margine_massimo??-Infinity));
    const compact=rows.map(({migliore,...other})=>other);
    console.log('RIEPILOGO',JSON.stringify({
      opportunita:OPPORTUNITA,veicolo:VEICOLO_ID,
      missioni_generate:missions.length,coppie_ammesse:result.coppie_ammesse,
      coppie_valutate:result.coppie_valutate,cicli_fattibili:result.cicli.length,
      routing_effettivo:routingEffettivo,dbWrites:result.dbWrites,
      nota:'Le esclusioni temporali, di richieste e capienza sono contate in ordine e solo sulle formazioni generate. La differenza fra ammissibili_pre_shadow e cicli_fattibili puo dipendere da routing, disponibilita, conflitti o limiti interni: questa tabella NON li distingue.'
    },null,2));
    console.log('TABELLA_COPPIE',JSON.stringify(compact,null,2));
    console.log('DETTAGLIO_115_120',JSON.stringify(get(115,120),null,2));
    console.log('DETTAGLIO_118_120',JSON.stringify(get(118,120),null,2));
    console.log('TOP_5_PER_MARGINE',JSON.stringify(rows.filter(r=>r.migliore)
      .sort((a,b)=>b.margine_massimo-a.margine_massimo).slice(0,5)
      .map(r=>({coppia:r.coppia,...r.migliore})),null,2));
    console.log('AVVERTENZA: il test NON prova ottimalita globale: generatore campionato, singolo orario per formazione, solo STANDARD non A/R.');
  }
} catch(error) {
  console.error('TEST REALE FALLITO:',error);
  process.exitCode=1;
} finally {
  if(transaction) {
    try { await client.query('ROLLBACK'); }
    catch(e) {console.error('ROLLBACK FALLITO',e);process.exitCode=1;}
  }
  client.release();
  await pool.end();
}
