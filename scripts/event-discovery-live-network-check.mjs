import 'dotenv/config';
import pg from 'pg';
import { open, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { databaseOptions } from '../config/database.js';

const client = new pg.Client({ ...databaseOptions(), connectionTimeoutMillis:10000 });
const output=resolve(process.argv[2] || `../event-live-network-${Date.now()}.json`);
let transaction=false;
try {
  await client.connect();
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); transaction=true;
  await client.query("SET LOCAL statement_timeout='30s'");
  const counts=(await client.query(`SELECT
    (SELECT count(*)::int FROM public.nodi_territoriali) AS nodes,
    (SELECT count(*)::int FROM public.nodi_territoriali WHERE attivo) AS active_nodes,
    (SELECT count(*)::int FROM public.pixel_fermate) AS stops,
    (SELECT count(*)::int FROM public.pixel_fermate WHERE attiva) AS active_stops,
    (SELECT count(*)::int FROM public.pixel_fermate WHERE attiva AND verificata) AS active_verified_stops,
    (SELECT count(*)::int FROM public.pixel_fermate p JOIN public.nodi_territoriali n ON n.id=p.nodo_territoriale_id
      WHERE p.attiva AND n.attivo AND p.posizione IS NOT NULL) AS active_stops_on_active_nodes`)).rows[0];
  const spatial=(await client.query(`SELECT 'nodes' AS kind,ST_SRID(posizione::geometry) AS srid,count(*)::int AS count
    FROM public.nodi_territoriali WHERE posizione IS NOT NULL GROUP BY 2 UNION ALL
    SELECT 'stops',ST_SRID(posizione::geometry),count(*)::int FROM public.pixel_fermate WHERE posizione IS NOT NULL GROUP BY 2`)).rows;
  const optional=(await client.query(`SELECT to_regclass('public.pixel_fermate_test_metadata') AS test_metadata,
    to_regclass('public.pixel_fermate_fonti') AS sources`)).rows[0];
  const exclusions=["p.nome !~* '^[[:space:]]*(\\[TEST PIXEL\\]|TEST PIXEL([[:space:]]|$))'"];
  if(optional.test_metadata)exclusions.push('NOT EXISTS (SELECT 1 FROM public.pixel_fermate_test_metadata tm WHERE tm.fermata_id=p.id)');
  if(optional.sources)exclusions.push("NOT EXISTS (SELECT 1 FROM public.pixel_fermate_fonti ff WHERE ff.fermata_id=p.id AND ff.stato_verifica='non_ammessa')");
  const eligible=exclusions.join(' AND ');
  const venues=`WITH venues AS (SELECT data->>'venue' AS venue,data->>'city' AS city,
      (data->>'lat')::double precision AS lat,(data->>'lng')::double precision AS lng,count(*)::int AS events
    FROM public.event_discovery_candidates WHERE external_key LIKE 'turentu-live-20261120-%' GROUP BY 1,2,3,4)
    SELECT v.*, x.* FROM venues v`;
  const nearestStops=(await client.query(`${venues}
    LEFT JOIN LATERAL (SELECT p.id AS stop_id,p.nome AS stop_name,p.verificata,n.id AS node_id,n.nome AS node_name,
      round(ST_Distance(p.posizione::geography,ST_SetSRID(ST_MakePoint(v.lng,v.lat),4326)::geography))::int AS metres
      FROM public.pixel_fermate p JOIN public.nodi_territoriali n ON n.id=p.nodo_territoriale_id AND n.attivo
      WHERE p.attiva AND p.posizione IS NOT NULL AND ST_SRID(p.posizione::geometry)=4326 AND ${eligible}
      ORDER BY ST_Distance(p.posizione::geography,ST_SetSRID(ST_MakePoint(v.lng,v.lat),4326)::geography),p.id LIMIT 3
    ) x ON true ORDER BY city,venue,metres`)).rows;
  const nearestNodes=(await client.query(`${venues}
    LEFT JOIN LATERAL (SELECT n.id AS node_id,n.nome AS node_name,
      round(ST_Distance(n.posizione::geography,ST_SetSRID(ST_MakePoint(v.lng,v.lat),4326)::geography))::int AS metres
      FROM public.nodi_territoriali n WHERE n.attivo AND n.posizione IS NOT NULL AND ST_SRID(n.posizione::geometry)=4326
      ORDER BY ST_Distance(n.posizione::geography,ST_SetSRID(ST_MakePoint(v.lng,v.lat),4326)::geography),n.id LIMIT 1
    ) x ON true ORDER BY city,venue`)).rows;
  const byVenue=[...new Map(nearestStops.map(r=>[r.city+'|'+r.venue,{
    city:r.city,venue:r.venue,events:r.events,
    stops:nearestStops.filter(s=>s.city===r.city&&s.venue===r.venue).map(s=>({id:s.stop_id,name:s.stop_name,
      verified:s.verificata,node:s.node_name,metres:s.metres}))
  }])).values()];
  const summary={...counts,venues:byVenue.length,
    eventsWithActiveNonTestStopsWithin10km:byVenue.filter(v=>v.stops.some(s=>s.id!=null&&s.metres<=10000)).reduce((n,v)=>n+v.events,0),
    byVenue};
  await client.query('ROLLBACK');transaction=false;
  await mkdir(dirname(output),{recursive:true});const fd=await open(output,'wx');
  try{await fd.writeFile(JSON.stringify({captured_at:new Date().toISOString(),summary,spatial,nearestStops,nearestNodes,
    exclusions,notice:'Read-only diagnostic. Unverified stops are proposals, not confirmed associations.'},null,2)+'\n');await fd.sync();}finally{await fd.close();}
  console.log(JSON.stringify({output,...summary}));
}catch(error){if(transaction)await client.query('ROLLBACK').catch(()=>{});console.error(JSON.stringify({error:error.code||error.message,databaseModified:false}));process.exitCode=1;}
finally{await client.end();}
