/**
 * TURENTU POPBUS — test SQL sovrapposizioni con dati sintetici
 * SOLO LETTURA: nessun INSERT, nessuna tabella temporanea, nessun worker.
 *
 * Salva in tests/test_popbus_conflitti_sintetici_sql.mjs
 * Esegui: node --env-file=.env tests/test_popbus_conflitti_sintetici_sql.mjs
 *
 * Esegue su PostgreSQL reale la SEMANTICA delle tre branche della query
 * (attivazioni, corse, direttrici) con CTE VALUES sintetiche.
 * NON esegue la funzione privata conflittiVeicolo del worker;
 * NON dimostra l'assenza di race condition o la correttezza dei dati reali.
 */
import assert from 'node:assert/strict';
import { pool } from '../db/db.js';

const sql = `
WITH
attivazioni(id, veicolo_id, stato, corsa_id, direttrice_id, partenza, arrivo, piano) AS (
 VALUES
 (1,353,'confermata',101::int,NULL::int,'2026-10-19T08:00:00Z'::timestamptz,'2026-10-19T12:00:00Z'::timestamptz,
  '{"busyStart":"2026-10-19T07:00:00Z","busyEnd":"2026-10-19T13:00:00Z"}'::jsonb),
 (2,352,'confermata',NULL::int,NULL::int,'2026-10-19T08:00:00Z'::timestamptz,'2026-10-19T12:00:00Z'::timestamptz,
  '{"busyStart":"2026-10-19T07:00:00Z","busyEnd":"2026-10-19T13:00:00Z"}'::jsonb),
 (3,353,'annullata',NULL::int,NULL::int,'2026-10-19T15:00:00Z'::timestamptz,'2026-10-19T18:00:00Z'::timestamptz,'{}'::jsonb)
),
corse(id,veicolo_id,stato,start_datetime,arrivo_datetime) AS (
 VALUES
 (101,353,'in_corso','2026-10-19T08:00:00Z'::timestamptz,'2026-10-19T12:00:00Z'::timestamptz),
 (102,353,'prenotabile','2026-10-19T14:00:00Z'::timestamptz,'2026-10-19T16:00:00Z'::timestamptz),
 (103,352,'prenotabile','2026-10-19T14:00:00Z'::timestamptz,'2026-10-19T16:00:00Z'::timestamptz)
),
direttrici_virtuali(id,veicolo_id,stato,partenza_prevista) AS (
 VALUES
 (201,353,'attivo','2026-10-19T17:00:00Z'::timestamptz),
 (202,352,'attivo','2026-10-19T17:00:00Z'::timestamptz)
),
segmenti(direttrice_id,start_datetime,tempo_stimato) AS (
 VALUES
 (201,'2026-10-19T17:00:00Z'::timestamptz,120::numeric),
 (202,'2026-10-19T17:00:00Z'::timestamptz,120::numeric)
)
SELECT origine,id,inizio,fine FROM (
 SELECT 'attivazione'::text AS origine,a.id::text AS id,
 COALESCE((a.piano->>'busyStart')::timestamptz,a.partenza) AS inizio,
 COALESCE((a.piano->>'busyEnd')::timestamptz,a.arrivo) AS fine
 FROM attivazioni a
 WHERE a.veicolo_id=$1
 AND a.stato IN ('in_attesa_autista','confermata')
 AND COALESCE((a.piano->>'busyStart')::timestamptz,a.partenza)<$3::timestamptz
 AND COALESCE((a.piano->>'busyEnd')::timestamptz,a.arrivo)>$2::timestamptz
 UNION ALL
 SELECT 'corsa',c.id::text,c.start_datetime,c.arrivo_datetime
 FROM corse c
 WHERE c.veicolo_id=$1
 AND c.stato IN ('prenotabile','in_corso','da_attivare')
 AND c.start_datetime<$3::timestamptz
 AND (c.arrivo_datetime IS NULL OR c.arrivo_datetime>$2::timestamptz)
 AND NOT EXISTS (
  SELECT 1 FROM attivazioni a
  WHERE a.corsa_id=c.id AND a.veicolo_id=c.veicolo_id
  AND a.stato IN ('in_attesa_autista','confermata')
 )
 UNION ALL
 SELECT 'direttrice',d.id::text,d.partenza_prevista,
 MAX(s.start_datetime+s.tempo_stimato*INTERVAL '1 minute')
 FROM direttrici_virtuali d JOIN segmenti s ON s.direttrice_id=d.id
 WHERE d.veicolo_id=$1
 AND d.stato IN ('in_attesa_autista','attivo','confermata')
 AND d.partenza_prevista<$3::timestamptz
 AND NOT EXISTS (
  SELECT 1 FROM attivazioni a
  WHERE a.direttrice_id=d.id AND a.veicolo_id=d.veicolo_id
  AND a.stato IN ('in_attesa_autista','confermata')
 )
 GROUP BY d.id,d.partenza_prevista
 HAVING MAX(s.start_datetime+s.tempo_stimato*INTERVAL '1 minute')>$2::timestamptz
) q ORDER BY origine,id
`;

const scenarios = [
  ['avvicinamento prima della partenza',353,'2026-10-19T07:30:00Z','2026-10-19T07:45:00Z',['attivazione:1']],
  ['ritorno dopo arrivo',353,'2026-10-19T12:30:00Z','2026-10-19T12:45:00Z',['attivazione:1']],
  ['corsa collegata non duplicata',353,'2026-10-19T09:00:00Z','2026-10-19T10:00:00Z',['attivazione:1']],
  ['confine esatto fine busy',353,'2026-10-19T13:00:00Z','2026-10-19T14:00:00Z',[]],
  ['corsa autonoma',353,'2026-10-19T14:30:00Z','2026-10-19T15:00:00Z',['corsa:102']],
  ['direttrice autonoma',353,'2026-10-19T17:30:00Z','2026-10-19T18:00:00Z',['direttrice:201']],
  ['dopo la direttrice',353,'2026-10-19T19:00:00Z','2026-10-19T20:00:00Z',[]],
  ['stesso titolare altro veicolo, fascia prima attivazione',352,'2026-10-19T09:00:00Z','2026-10-19T10:00:00Z',['attivazione:2']],
  ['altro veicolo non bloccato da 353',352,'2026-10-19T12:00:00Z','2026-10-19T12:30:00Z',['attivazione:2']],
  ['veicolo senza impegni',354,'2026-10-19T09:00:00Z','2026-10-19T10:00:00Z',[]]
];
// NB: per il veicolo 352 il busyEnd sintetico e' 13:00: il caso 12-12:30
// DEVE rilevare la sua attivazione, indipendentemente dal veicolo 353.
let client;
let failed=0;
try {
 client=await pool.connect();
 await client.query('BEGIN READ ONLY');
 const info=await client.query("SELECT current_database() AS database, current_user AS utente, current_setting('transaction_read_only') AS sola_lettura");
 console.log('=== TEST SQL SINTETICO POPBUS ===');
 console.log(info.rows[0]);
 for (const [name,vehicle,start,end,expected] of scenarios) {
   const {rows}=await client.query(sql,[vehicle,start,end]);
   const actual=rows.map(r=>`${r.origine}:${r.id}`).sort();
   try {
     assert.deepEqual(actual,[...expected].sort());
     console.log(`PASS ${name}: ${actual.join(', ')||'nessun conflitto'}`);
   } catch(e) {
     failed++;
     console.error(`FAIL ${name}: attesi=${expected.join(',')}, ottenuti=${actual.join(',')}`);
   }
 }
} catch(e) {
 failed++;
 console.error('ERRORE:',e.message);
} finally {
 if(client) {
   try { await client.query('ROLLBACK'); } catch(e) {console.error('ROLLBACK:',e.message);failed++;}
   client.release();
 }
 await pool.end();
}
console.log(`\nEsito: ${scenarios.length-failed}/${scenarios.length} scenari superati (se non ci sono errori infrastrutturali).`);
console.log('Nessuna scrittura; il test non prova la funzione worker in produzione.');
if(failed) process.exitCode=1;
