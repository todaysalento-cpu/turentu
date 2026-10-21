// TURENTU POPBUS V2 - E2E ottimizzazione temporale + Shadow, SOLO LETTURA.
// Copiare in tests/test_pixel_multimission_ottimizzato.mjs
// Eseguire: node --env-file=.env tests\test_pixel_multimission_ottimizzato.mjs
import { pool } from '../db/db.js';
import { leggiContestiOpportunitaPixel } from '../services/popbus/v2/pixel-opportunity-adapter.js';
import { generaFormazioniAlternative, verificaQualitaRichieste, TOLLERANZA_MS } from '../services/popbus/v2/model.js';
import { leg } from '../services/popbus/v2/planner.js';
import { verificaTurnoVeicolo } from '../services/popbus/v2/popbus-vehicle-availability.js';
import { ottimizzaCoppiaTemporale } from '../services/popbus/v2/pixel-multimission-time-optimizer.js';
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
        // Intersezione ESATTA: finestra PIXEL e tolleranza al nodo di salita di OGNI richiesta.
        let lower=Number(ctx.window.start), upper=Number(ctx.window.end);
        for(const r of selected) {
          const boardingIndex=ctx.plan.nodes.findIndex(id=>Number(id)===Number(r.start_node_id));
          if(boardingIndex<0) throw new Error('Nodo salita mancante');
          const requested=new Date(r.start_datetime).getTime();
          const offset=Number(evaluation.times[boardingIndex]);
          if(!Number.isFinite(requested)||!Number.isFinite(offset)) throw new Error('Vincolo temporale non valido');
          lower=Math.max(lower,requested-offset-TOLLERANZA_MS);
          upper=Math.min(upper,requested-offset+TOLLERANZA_MS);
        }
        if(lower>upper || evaluation.departure<lower-1 || evaluation.departure>upper+1)
          throw new Error(`Finestra formazione incoerente: ${ctx.pixel_opportunita_id}`);
        seen.add(key);
        missions.push({
          lower,upper,
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
    const targetA=missions.filter(m=>m.pixelOpportunitaId===115);
    const targetB=missions.filter(m=>m.pixelOpportunitaId===119);
    const counts={combinazioni:0,duplicate:0,gia_fattibili:0,recuperate:0,impossibili:0,
      recuperate_con_turno_e_conflitti_validi:0,recuperate_rifiutate_dal_preflight:0,
      recuperate_con_ciclo_shadow:0,recuperate_economicamente_attivabili:0};
    const samples=[];
    const best=[];
    const baseVehicle={id:Number(vehicle.id),lat:Number(vehicle.lat),lon:Number(vehicle.lon),
      euroKm:Number(vehicle.euro_km),posti_totali:Number(vehicle.posti_totali)};
    for(const a of targetA) for(const b of targetB) {
      counts.combinazioni++;
      const out=await ottimizzaCoppiaTemporale({a,b,movement});
      if(out.stato==='RICHIESTE_DUPLICATE'){counts.duplicate++;continue;}
      if(out.stato==='TRASFERIMENTO_IMPOSSIBILE'){counts.impossibili++;continue;}
      if(out.stato==='GIA_FATTIBILE'){counts.gia_fattibili++;continue;}
      counts.recuperate++;
      if(Number(a.peak)>baseVehicle.posti_totali || Number(b.peak)>baseVehicle.posti_totali) {
        counts.recuperate_rifiutate_dal_preflight++;continue;
      }
      // Ricontrollo della nuova partenza all'interno della finestra esatta di ciascuna formazione.
      if(out.missione_a.departure<a.lower || out.missione_a.departure>a.upper ||
         out.missione_b.departure<b.lower || out.missione_b.departure>b.upper)
        throw new Error('Partenza ottimizzata fuori finestra');
      // L'originale ha gia validato i nodi di salita, la qualita e la capienza.
      // Uno spostamento uniforme dentro [lower,upper] conserva tali vincoli
      // nel modello a durata fissa; qui si verifica anche il ciclo operativo.
      const preview=await anteprimaCicliMultimissione({
        missions:[out.missione_a,out.missione_b],vehicles:[baseVehicle],movement,
        isAvailable:async(_v,s,e)=>verificaTurnoVeicolo(vehicle,s,e),
        hasConflicts:async(_v,s,e)=>conflicts(client,vehicle.id,s,e),
        validatePair:async()=>true,
        now:Date.now(),maxPairs:1,maxRoutingCalls:10,
        costoAttesaOraEuro:Number(process.env.POPBUS_PIXEL_COSTO_ATTESA_ORA_EURO||0),
        altriCostiEuro:Number(process.env.POPBUS_PIXEL_ALTRI_COSTI_EURO||0),
        margineMinimoEuro:Number(process.env.POPBUS_PIXEL_MARGINE_MINIMO_EURO||0)
      });
      if(preview.cicli.length) {
        counts.recuperate_con_turno_e_conflitti_validi++;
        counts.recuperate_con_ciclo_shadow++;
        const c=preview.cicli[0];
        if(c.soglia_raggiunta_economicamente) counts.recuperate_economicamente_attivabili++;
        best.push(c);
        if(samples.length<3) samples.push({richieste_a:a.requests.map(r=>r.id),
          richieste_b:b.requests.map(r=>r.id),
          partenza_a:new Date(out.partenza_a).toISOString(),
          partenza_b:new Date(out.partenza_b).toISOString(),
          margine_trasferimento_min:out.margine_ottimizzato_min,
          ricavo_lordo_euro:c.ricavo_lordo_euro,
          soglia_lorda_euro:c.soglia_attivazione_lorda_euro,
          margine_euro:c.margine_euro,
          attivabile_economicamente:c.soglia_raggiunta_economicamente});
      } else counts.recuperate_rifiutate_dal_preflight++;
    }
    best.sort((a,b)=>b.margine_euro-a.margine_euro);
    console.log('RIEPILOGO_OTTIMIZZATORE',JSON.stringify({
      veicolo:VEICOLO_ID,coppia:'115->119',...counts,
      routing_reale_effettivo:routingEffettivo,dbWrites:0,
      miglior_ciclo_recuperato:best[0]||null,
      esempi: samples,
      nota:'Solo STANDARD non AR, finestre intersecate, durata missione invariata, formazioni campionate; nessuna attivazione LIVE.'
    },null,2));

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
