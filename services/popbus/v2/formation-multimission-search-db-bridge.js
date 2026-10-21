// TURENTU - Multimission Search diagnostics, READ ONLY, never bookable.
import { pool } from '../../../db/db.js';
import { leggiContestiOpportunitaPixel } from './pixel-opportunity-adapter.js';
import { leg } from './planner.js';
import { verificaTurnoVeicolo } from './popbus-vehicle-availability.js';
import { anteprimaMultimissionePerSearch } from './formation-multimission-search-preview.js';

const MAX_CONTEXTS = 100;
const MAX_VEHICLES = 35;
const MAX_ROUTING = 100;
const validId = n => Number.isSafeInteger(Number(n)) && Number(n) > 0;
const same = (a,b) => Math.abs(Number(a.lat)-Number(b.lat)) < 1e-7 && Math.abs(Number(a.lon)-Number(b.lon)) < 1e-7;

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
    LIMIT 1`, [vehicleId, new Date(start), new Date(end)]);
  return rows.length > 0;
}

export async function anteprimaMultimissioneSearchDB(opts = {}) {
  const startId=Number(opts.start_node_id), endId=Number(opts.end_node_id);
  const when=new Date(opts.start_datetime).getTime(), seats=Number(opts.posti_richiesti);
  if (!validId(startId) || !validId(endId) || startId===endId ||
      !Number.isFinite(when) || when<=Date.now() || !Number.isSafeInteger(seats) || seats<1)
    throw new Error('Multimission Search: input invalido');
  const prices=Object.entries(opts.prezzi || {}).filter(([c,p]) =>
    ['EXPRESS','STANDARD','SAVER'].includes(c) && p !== null && p !== '' &&
    Number.isFinite(Number(p)) && Number(p)>=0);
  if (!prices.length) return {shadow:true, dbWrites:0, simulazione_non_prenotabile:true, classi:{}};
  const client=await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const contexts=await leggiContestiOpportunitaPixel({client,limit:MAX_CONTEXTS+1});
    if (contexts.length>MAX_CONTEXTS) throw new Error('Troppe opportunita PIXEL');
    // Mission B may lie on a DIFFERENT corridor. Do not restrict all contexts to the user's OD.
    const relevant=contexts.filter(c => c.window.end>=when-30*60000 &&
      c.window.start<=when+30*60000 && c.plan.nodes.indexOf(startId)>=0 &&
      c.plan.nodes.indexOf(endId)>c.plan.nodes.indexOf(startId));
    if (!relevant.length) {
      await client.query('COMMIT');
      return {shadow:true,dbWrites:0,simulazione_non_prenotabile:true,classi:{}};
    }
    // Include other PIXEL missions near the selected date, not just the user's corridor.
    const earliest=Math.min(...relevant.map(c=>c.window.start));
    const latest=Math.max(...relevant.map(c=>c.window.end));
    const candidates=contexts.filter(c=>c.window.end>=earliest-4*3600000 &&
      c.window.start<=latest+4*3600000);
    const nodeIds=[...new Set(candidates.flatMap(c=>c.plan.nodes.map(Number)))];
    const {rows:nodes}=await client.query(`SELECT id,ST_Y(posizione::geometry) AS lat,
      ST_X(posizione::geometry) AS lon FROM public.nodi_territoriali
      WHERE attivo=TRUE AND id=ANY($1::bigint[])`,[nodeIds]);
    if (nodes.length!==nodeIds.length) throw new Error('Nodi PIXEL incompleti');
    const nodesById=new Map(nodes.map(n=>[Number(n.id),{lat:Number(n.lat),lon:Number(n.lon)}]));
    const {rows:rawVehicles}=await client.query(`
      SELECT v.id,v.driver_id,v.posti_totali,t.euro_km,
        dv.start,dv.fine,dv.manual,dv.giorni_esclusi,dv.inattivita,
        ST_Y(COALESCE(dv.coord,v.coord)::geometry) AS lat,
        ST_X(COALESCE(dv.coord,v.coord)::geometry) AS lon
      FROM public.veicolo v
      JOIN public.disponibilita_veicolo dv ON dv.veicolo_id=v.id
      JOIN LATERAL (SELECT MIN(euro_km) AS euro_km FROM public.tariffe
        WHERE veicolo_id=v.id AND tipo='standard' AND euro_km>0) t ON t.euro_km IS NOT NULL
      WHERE v.driver_id IS NOT NULL AND v.posti_totali>0
        AND COALESCE(dv.coord,v.coord) IS NOT NULL
      ORDER BY v.id LIMIT $1`,[MAX_VEHICLES+1]);
    if (rawVehicles.length>MAX_VEHICLES) throw new Error('Troppi veicoli');
    const vehicles=rawVehicles.map(v=>({...v,euroKm:Number(v.euro_km),
      lat:Number(v.lat),lon:Number(v.lon),posti_totali:Number(v.posti_totali)}));
    const maxId=Math.max(0,...contexts.flatMap(c=>c.richiesta_ids.map(Number)));
    if (!Number.isSafeInteger(maxId) || maxId>Number.MAX_SAFE_INTEGER-prices.length)
      throw new Error('ID sintetico non sicuro');
    const routeCache=new Map(); let calls=0;
    const movement=async (a,b)=>{
      if (same(a,b)) return {metres:0,seconds:0};
      const k=`${a.lat},${a.lon}>${b.lat},${b.lon}`;
      if (!routeCache.has(k)) {
        if (++calls>MAX_ROUTING) throw new Error('Budget routing multimissione esaurito');
        const r=await leg(a,b);
        if (!r || !Number.isFinite(Number(r.metres)) || !Number.isFinite(Number(r.seconds)) ||
            Number(r.metres)<0 || Number(r.seconds)<0) throw new Error('Routing invalido');
        routeCache.set(k,{metres:Number(r.metres),seconds:Number(r.seconds)});
      }
      return routeCache.get(k);
    };
    const classes={};
    for (const [classe,prezzo] of prices) {
      const virtualRequest={id:maxId+1+prices.findIndex(x=>x[0]===classe),
        start_node_id:startId,end_node_id:endId,
        start_datetime:new Date(when).toISOString(),posti_richiesti:seats,
        prezzo:Number(prezzo),classe};
      classes[classe]=await anteprimaMultimissionePerSearch({
        contexts:candidates,nodesById,virtualRequest,vehicles,movement,
        isAvailable:async(v,a,b)=>verificaTurnoVeicolo(v,a,b),
        hasConflicts:async(v,a,b)=>conflicts(client,Number(v.id),a,b),
        now:Date.now(),maxMissioni:200,maxPairs:1200,maxRoutingCalls:MAX_ROUTING
      });
    }
    await client.query('COMMIT');
    return {shadow:true,dbWrites:0,simulazione_non_prenotabile:true,classi:classes};
  } catch(err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {client.release();}
}
