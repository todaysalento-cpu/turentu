import 'dotenv/config';
import pg from 'pg';
import { readFile, open, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { databaseOptions } from '../config/database.js';
import { normalize, fingerprint, keyText, hash } from '../services/event-discovery/extract.js';

// No DELETE, publication, source activation or territorial write is supported.
// audit: consistent read-only event snapshot. stage: pending candidates only.
const [mode, outputArg, catalogArg] = process.argv.slice(2);
if (!['audit', 'stage'].includes(mode) || !outputArg) {
  throw new Error('Usage: node --env-file=PATH scripts/event-discovery-live.mjs audit|stage NEW_OUTPUT.json [catalog.json]');
}
const output = resolve(outputArg);
const catalogPath = catalogArg || fileURLToPath(new URL('../data/event-discovery-live/catalogo-20261120.json', import.meta.url));
const client = new pg.Client({ ...databaseOptions(), connectionTimeoutMillis: 10000 });
async function durableFile(path, data) {
  await mkdir(dirname(path), { recursive: true });
  const fd = await open(path, 'wx');
  try { await fd.writeFile(JSON.stringify(data, null, 2) + '\n'); await fd.sync(); }
  finally { await fd.close(); }
}
let inTransaction = false;
try {
  await client.connect();
  await client.query(mode === 'audit' ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN ISOLATION LEVEL SERIALIZABLE');
  inTransaction = true;
  await client.query("SET LOCAL statement_timeout='30s'");
  await client.query("SET LOCAL lock_timeout='5s'");
  if (mode === 'stage') await client.query('SELECT pg_advisory_xact_lock(645019,2)');
  const tables = (await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public'
    AND (table_name='eventi' OR table_name LIKE 'event_discovery_%') ORDER BY table_name`)).rows;
  if (!tables.some(t => t.table_name === 'eventi')) throw new Error('Schema eventi non trovato');
  const snapshot = { captured_at: new Date().toISOString(), mode, tables: {} };
  for (const { table_name } of tables) snapshot.tables[table_name] = (await client.query('SELECT * FROM public.' + table_name)).rows;
  snapshot.constraints = (await client.query(`SELECT conrelid::regclass::text AS tabella,pg_get_constraintdef(oid) AS definizione
    FROM pg_constraint WHERE confrelid='public.eventi'::regclass OR conrelid='public.eventi'::regclass`)).rows;
  const groups = new Map();
  for (const e of snapshot.tables.eventi) {
    const key = JSON.stringify([keyText(e.titolo), e.data_inizio, keyText(e.citta), keyText(e.luogo_nome)]);
    groups.set(key, [...(groups.get(key) || []), e.id]);
  }
  snapshot.possible_duplicates = [...groups.values()].filter(ids => ids.length > 1);
  snapshot.possible_test_records = snapshot.tables.eventi.filter(e => /\b(test|prova|demo|fixture|sintetic[oa])\b/i.test(e.titolo || ''))
    .map(e => ({ id: e.id, title: e.titolo, certainty: 'ambiguous_requires_evidence_and_confirmation' }));
  snapshot.dependencies = (await client.query(`SELECT 'corse' AS tabella,evento_id,count(*)::int AS count FROM public.corse
    WHERE evento_id IS NOT NULL GROUP BY evento_id UNION ALL
    SELECT 'richieste_pop_bus',evento_id,count(*)::int FROM public.richieste_pop_bus WHERE evento_id IS NOT NULL GROUP BY evento_id`)).rows;
  await durableFile(output, snapshot);
  if (mode === 'audit') {
    await client.query('ROLLBACK'); inTransaction = false;
    console.log(JSON.stringify({ mode, output, events: snapshot.tables.eventi.length,
      possibleDuplicates: snapshot.possible_duplicates.length, possibleTests: snapshot.possible_test_records.length }));
  } else {
    for (const table of ['event_discovery_sources','event_discovery_candidates','event_discovery_audit']) {
      if (!snapshot.tables[table]) throw new Error('Modulo Event Discovery assente: ' + table);
    }
    const raw = await readFile(catalogPath, 'utf8');
    const catalog = JSON.parse(raw);
    const result = { catalog_sha256: hash(raw), staged: [], skipped: [] };
    for (const item of catalog.events) {
      const data = normalize(item, { timezone: 'Europe/Rome', url: item.url });
      if (!item.id || item.verification?.title_date_time_venue !== 'official_calendar_checked' || !item.verified_on ||
        !data.title || !data.category || !data.venue || !data.city || !data.start?.includes('T') ||
        Date.parse(data.start) <= Date.now() || data.lat == null || data.lng == null || !data.url?.startsWith('https://') ||
        data.title.length > 255 || data.category.length > 50 || data.venue.length > 255 || data.city.length > 100) {
        throw new Error('Candidato incompleto o scaduto: ' + item.id);
      }
      const fp = fingerprint(data);
      const known = snapshot.tables.eventi.filter(e => keyText(e.titolo) === keyText(data.title) &&
        (!e.citta || keyText(e.citta) === keyText(data.city)) && Math.abs(Date.parse(e.data_inizio) - Date.parse(data.start)) <= 86400000);
      const duplicate = await client.query(`SELECT id FROM public.event_discovery_candidates WHERE fingerprint=$1 OR external_key=$2 LIMIT 1`, [fp, item.id]);
      if (known.length || duplicate.rowCount) { result.skipped.push({ id: item.id, events: known.map(e => e.id), candidate: duplicate.rows[0]?.id }); continue; }
      let { rows: [source] } = await client.query('SELECT id FROM public.event_discovery_sources WHERE url=$1', [data.url]);
      if (!source) ({ rows: [source] } = await client.query(`INSERT INTO public.event_discovery_sources
        (name,url,domain,kind,state,terms) VALUES ($1,$2,$3,'html','in_verifica',$4) RETURNING id`,
        [new URL(data.url).hostname, data.url, new URL(data.url).hostname, 'Inserimento editoriale manuale di dati fattuali. Nessuna acquisizione automatica abilitata.']));
      const evidence = { verification: item.verification, verified_on: item.verified_on, catalog_sha256: result.catalog_sha256,
        attribution: { publisher: 'andiamoinpuglia.it (coordinate della sede)', recordUrl: item.verification.coordinates_source,
          license: 'CC BY 4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/', primaryUrl: data.url } };
      const { rows: [candidate] } = await client.query(`INSERT INTO public.event_discovery_candidates
        (source_id,external_key,data,evidence,fingerprint,confidence,state,auto_publish)
        VALUES ($1,$2,$3,$4,$5,80,'pending',false) RETURNING id`, [source.id,item.id,data,evidence,fp]);
      result.staged.push(candidate.id);
      await client.query(`INSERT INTO public.event_discovery_audit (actor_id,action,entity_id,details)
        VALUES (NULL,'live-catalog-stage',$1,$2)`, [candidate.id, { catalog_sha256: result.catalog_sha256, backup: output }]);
    }
    await client.query('COMMIT'); inTransaction = false;
    console.log(JSON.stringify({ mode, backup: output, ...result }));
  }
} catch (error) {
  if (inTransaction) await client.query('ROLLBACK').catch(() => {});
  console.error(JSON.stringify({ mode, error: error.code || error.message, committed: false }));
  process.exitCode = 1;
} finally { await client.end(); }
