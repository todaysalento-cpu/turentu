// TURENTU POPBUS V2 - Diagnostica cause di esclusione PIXEL -> POPBUS -> Shadow, SOLO LETTURA.
// Copiare in tests/test_pixel_multimission_coppie.mjs
// Eseguire: node --env-file=.env tests\test_pixel_multimission_cause.mjs
import { pool } from '../db/db.js';
import { leggiContestiOpportunitaPixel } from '../services/popbus/v2/pixel-opportunity-adapter.js';
import { generaFormazioniAlternative, verificaQualitaRichieste } from '../services/popbus/v2/model.js';
import { leg } from '../services/popbus/v2/planner.js';
import { verificaTurnoVeicolo } from '../services/popbus/v2/popbus-vehicle-availability.js';

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
    // Diagnostica esplicita nello stesso ordine di controllo dello Shadow.
    // Nessuna modifica allo Shadow: classifica ciascuna coppia generata.
    const TARGETS = new Set(['118->120','118->117','115->119','115->120']);
    const counters = new Map();
    const get = key => {
      if (!counters.has(key)) counters.set(key, {
        coppia:key, combinazioni:0, ordine_temporale:0,
        richieste_duplicate:0, capienza:0, trasferimento_impossibile:0,
        partenza_base_passata:0, turno_non_disponibile:0, conflitto:0,
        fattibili:0, esempio_trasferimento:null, esempio_fattibile:null,
        esempio_turno:null, esempio_conflitto:null
      });
      return counters.get(key);
    };
    const base={lat:Number(vehicle.lat),lon:Number(vehicle.lon)};
    const now=Date.now();
    const availableCache=new Map();
    const conflictCache=new Map();
    const stats={coppie_esaminate:0,pre_shadow:0,controlli_disponibilita:0,controlli_conflitti:0};
    const time = t => new Date(t).toISOString();
    const sample=(a,b,transfer,approach,ret)=>({
      opportunita:[a.pixelOpportunitaId,b.pixelOpportunitaId],
      richieste_a:a.requests.map(r=>r.id),richieste_b:b.requests.map(r=>r.id),
      partenza_a:time(a.departure),arrivo_a:time(a.arrival),
      trasferimento_km:Number((transfer.metres/1000).toFixed(3)),
      trasferimento_min:Number((transfer.seconds/60).toFixed(2)),
      arrivo_alla_seconda_origine:time(a.arrival+transfer.seconds*1000),
      partenza_b:time(b.departure),
      margine_temporale_min:Number(((b.departure-a.arrival-transfer.seconds*1000)/60000).toFixed(2)),
      partenza_base:time(a.departure-approach.seconds*1000),
      ritorno_base:time(b.arrival+ret.seconds*1000)
    });
    for(const a of missions) for(const b of missions) {
      if(a===b) continue;
      const key=`${a.pixelOpportunitaId}->${b.pixelOpportunitaId}`;
      if(!TARGETS.has(key)) continue;
      const st=get(key); st.combinazioni++; stats.coppie_esaminate++;
      if(a.arrival>b.departure || a.departure<=now) {st.ordine_temporale++;continue;}
      const ids=new Set(a.requests.map(r=>r.id));
      if(b.requests.some(r=>ids.has(r.id))) {st.richieste_duplicate++;continue;}
      if(a.peak>Number(vehicle.posti_totali)||b.peak>Number(vehicle.posti_totali)) {st.capienza++;continue;}
      stats.pre_shadow++;
      const approach=await movement(base,a.from);
      const transfer=await movement(a.to,b.from);
      const ret=await movement(b.to,base);
      const detail=sample(a,b,transfer,approach,ret);
      if(a.arrival+transfer.seconds*1000>b.departure) {
        st.trasferimento_impossibile++;
        if(!st.esempio_trasferimento || detail.margine_temporale_min>st.esempio_trasferimento.margine_temporale_min)
          st.esempio_trasferimento=detail;
        continue;
      }
      const busyStart=a.departure-approach.seconds*1000;
      const busyEnd=b.arrival+ret.seconds*1000;
      if(busyStart<=now) {st.partenza_base_passata++;continue;}
      const interval=`${busyStart}|${busyEnd}`;
      if(!availableCache.has(interval)) {
        stats.controlli_disponibilita++;
        availableCache.set(interval,verificaTurnoVeicolo(vehicle,busyStart,busyEnd));
      }
      if(!availableCache.get(interval)) {
        st.turno_non_disponibile++;
        if(!st.esempio_turno) st.esempio_turno=detail;
        continue;
      }
      if(!conflictCache.has(interval)) {
        stats.controlli_conflitti++;
        conflictCache.set(interval,await conflicts(client,Number(vehicle.id),busyStart,busyEnd));
      }
      if(conflictCache.get(interval)) {
        st.conflitto++;
        if(!st.esempio_conflitto) st.esempio_conflitto=detail;
        continue;
      }
      st.fattibili++;
      if(!st.esempio_fattibile) st.esempio_fattibile=detail;
    }
    const rows=[...TARGETS].map(k=>get(k));
    for(const st of rows) {
      const sum=st.ordine_temporale+st.richieste_duplicate+st.capienza+
        st.trasferimento_impossibile+st.partenza_base_passata+
        st.turno_non_disponibile+st.conflitto+st.fattibili;
      if(sum!==st.combinazioni) throw new Error(`Contatori incoerenti per ${st.coppia}: ${sum} != ${st.combinazioni}`);
    }
    console.log('RIEPILOGO_DIAGNOSTICA',JSON.stringify({
      veicolo:VEICOLO_ID,missioni_generate:missions.length,
      routing_effettivo:routingEffettivo,dbWrites:0,
      ...stats,nota:'Classificazione delle sole coppie selezionate, sulle formazioni generate; non certifica ottimalita globale.'
    },null,2));
    console.log('CAUSE_PER_COPPIA',JSON.stringify(rows,null,2));
    console.log('ATTENZIONE: test read-only. La classificazione replica i controlli Shadow senza cambiare il motore; le callback di routing devono restituire dati reali.');
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
