import 'dotenv/config';
import pg from 'pg';
import { readFile, open, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { databaseOptions } from '../config/database.js';
import { normalize, fingerprint, hash } from '../services/event-discovery/extract.js';

const quote = value => '"' + value.replaceAll('"', '""') + '"';
const output = resolve(process.argv[2] || `../event-live-check-${Date.now()}.json`);
const client = new pg.Client({ ...databaseOptions(), connectionTimeoutMillis: 10000 });
let transaction = false;
try {
  await client.connect();
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  transaction = true;
  await client.query("SET LOCAL statement_timeout='30s'");
  const raw = await readFile(new URL('../data/event-discovery-live/catalogo-20261120.json', import.meta.url), 'utf8');
  const catalog = JSON.parse(raw);
  const catalogHash = hash(raw);
  const candidates = (await client.query(`SELECT id,external_key,data,evidence,state,event_id,auto_publish
    FROM public.event_discovery_candidates WHERE external_key LIKE 'turentu-live-20261120-%' ORDER BY id`)).rows;
  const byKey = new Map(candidates.map(c => [c.external_key,c]));
  const missing = [], mismatched = [];
  for (const event of catalog.events) {
    const candidate = byKey.get(event.id);
    if (!candidate) missing.push(event.id);
    else if (fingerprint(candidate.data) !== fingerprint(normalize(event, { timezone:'Europe/Rome',url:event.url })) ||
      candidate.evidence.catalog_sha256 !== catalogHash || candidate.data.lat !== event.lat || candidate.data.lng !== event.lng) {
      mismatched.push({ catalog_id:event.id,candidate_id:candidate.id });
    }
  }
  const events = (await client.query('SELECT * FROM public.eventi ORDER BY id')).rows;
  const sources = (await client.query(`SELECT id,name,url,kind,state,last_sync,last_result,last_count
    FROM public.event_discovery_sources ORDER BY id`)).rows;
  const foreignKeys = (await client.query(`SELECT ns.nspname AS schema_name,cl.relname AS table_name,a.attname AS column_name,
    pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c
    JOIN pg_class cl ON cl.oid=c.conrelid JOIN pg_namespace ns ON ns.oid=cl.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=ANY(c.conkey)
    WHERE c.contype='f' AND c.confrelid='public.eventi'::regclass ORDER BY ns.nspname,cl.relname,a.attname`)).rows;
  const dependencies = [];
  for (const fk of foreignKeys) {
    const qtable = quote(fk.schema_name)+'.'+quote(fk.table_name), qcolumn=quote(fk.column_name);
    const rows=(await client.query(`SELECT ${qcolumn} AS event_id,count(*)::int AS count FROM ${qtable}
      WHERE ${qcolumn}=ANY($1::integer[]) GROUP BY ${qcolumn} ORDER BY ${qcolumn}`, [events.map(e=>e.id)])).rows;
    dependencies.push({...fk,rows});
  }
  const eventStops = (await client.query("SELECT to_regclass('public.eventi_fermate_pixel') AS name")).rows[0].name
    ? (await client.query('SELECT * FROM public.eventi_fermate_pixel WHERE evento_id=ANY($1::integer[])',[events.map(e=>e.id)])).rows : [];
  const sql = await readFile(new URL('../sql/event-live-territory-preview.sql', import.meta.url),'utf8');
  const preview = sql.slice(sql.indexOf('SELECT c.id'),sql.lastIndexOf('ROLLBACK;')).trim();
  const territorySuggestions = (await client.query(preview)).rows;
  const covered = new Set(territorySuggestions.map(r=>r.candidate_id));
  const perCity = {};
  for (const c of candidates) {
    const row=perCity[c.data.city] ||= { candidates:0,withNearbyStops:0 };
    row.candidates++; if(covered.has(c.id))row.withNearbyStops++;
  }
  const states = {};
  for (const c of candidates) states[c.state]=(states[c.state]||0)+1;
  const summary = { catalogEvents:catalog.events.length,candidatesFound:candidates.length,states,
    autoPublishEnabled:candidates.filter(c=>c.auto_publish).length,linkedToPublicEvents:candidates.filter(c=>c.event_id!=null).length,
    missingCatalogRecords:missing.length,mismatchedCatalogRecords:mismatched.length,
    existingPublicEvents:events.length,withNearbyStops:covered.size,withoutNearbyStops:candidates.length-covered.size,perCity };
  const report={captured_at:new Date().toISOString(),mode:'read_only_verification',catalog_sha256:catalogHash,summary,
    missing,mismatched,candidates,events,sources,dependencies,eventStops,territorySuggestions,
    territoryWarning:'Proximity proposals only. No stop association, deletion, approval or publication was performed.'};
  await client.query('ROLLBACK'); transaction=false;
  await mkdir(dirname(output),{recursive:true});
  const fd=await open(output,'wx');
  try {await fd.writeFile(JSON.stringify(report,null,2)+'\n');await fd.sync();}finally{await fd.close();}
  console.log(JSON.stringify({output,...summary}));
} catch(error) {
  if(transaction)await client.query('ROLLBACK').catch(()=>{});
  console.error(JSON.stringify({error:error.code||error.message,databaseModified:false}));
  process.exitCode=1;
} finally {await client.end();}
