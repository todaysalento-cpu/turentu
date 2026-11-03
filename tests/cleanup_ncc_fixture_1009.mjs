import 'dotenv/config';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { pool } from '../db/db.js';
const journalPath = 'tests/TURENTU_NCC_STRIPE_TEST_1793655867212_9048.journal.json';
const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
const fixtures = journal.fixtures;
const f = fixtures.find(x => Number(x.rideId) === 1009);
if (!f || fixtures.length !== 1 || f.marker !== 'TURENTU_NCC_STRIPE_TEST_1793655867212_9048_COMPLETA' || f.cleaned) throw new Error('BLOCCO: journal non conforme');
function saveJournal() { const tmp=journalPath+'.tmp'; writeFileSync(tmp,JSON.stringify(journal,null,2)); renameSync(tmp,journalPath); }
async function cleanup(f) {
  // Cancella esclusivamente le fixture marcate dal test, in ordine FK.
  // Se uno scenario non e completo, preserva i dati per riconciliazione.
  if (Number(f.rideId) !== 1009 || f.cleaned) throw new Error('CLEANUP BLOCCATO: fixture non autorizzata');
  if (!Array.isArray(f.userIds) || f.userIds.length !== 3 || new Set(f.userIds).size !== 3) throw new Error('CLEANUP BLOCCATO: clienti sintetici non identificati');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const ride = await c.query('SELECT origine_address, stato FROM public.corse WHERE id=$1 FOR UPDATE',[f.rideId]);
    if (ride.rows[0]?.origine_address !== f.marker || ride.rows[0]?.stato !== 'completata') throw new Error('Marker differente: pulizia bloccata');
    const users = await c.query('SELECT id FROM public.utente WHERE id = ANY($1::int[]) AND tipo=$2 AND nome LIKE $3', [f.userIds, 'cliente', f.marker + '%']);
    if (users.rows.length !== 3) throw new Error('CLEANUP BLOCCATO: identita clienti TEST non verificata');
    const dependencies = await c.query('SELECT (SELECT concat_ws(chr(46), n.nspname, cl.relname) FROM pg_class cl JOIN pg_namespace n ON n.oid=cl.relnamespace WHERE cl.oid=pc.conrelid) AS tabella, a.attname AS colonna FROM pg_constraint pc JOIN LATERAL unnest(pc.conkey) AS k(attnum) ON true JOIN pg_attribute a ON a.attrelid=pc.conrelid AND a.attnum=k.attnum WHERE pc.contype=$1 AND pc.confrelid=$2::regclass', ['f', 'public.utente']);
    for (const dep of dependencies.rows) { const q = x => String.fromCharCode(34) + x.replaceAll(String.fromCharCode(34), String.fromCharCode(34,34)) + String.fromCharCode(34); const table = dep.tabella.split('.').map(q).join('.'); const column = q(dep.colonna); const r = await c.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${column} = ANY($1::int[])`, [f.userIds]); if (r.rows[0].n > 0 && !(dep.tabella.split('.').pop() === 'prenotazioni' && dep.colonna === 'cliente_id' && r.rows[0].n === 3)) throw new Error(`CLEANUP BLOCCATO: riferimenti in ${dep.tabella}.${dep.colonna}`); }
    const bookings = await c.query('SELECT id, cliente_id FROM public.prenotazioni WHERE cliente_id = ANY($1::int[]) FOR UPDATE', [f.userIds]); if (bookings.rows.length !== 3 || bookings.rows.some(x => !f.items.some(i => Number(i.prenId) === Number(x.id)) || !f.userIds.includes(Number(x.cliente_id)))) throw new Error('CLEANUP BLOCCATO: prenotazioni sintetiche non corrispondenti');
    const payments = await c.query('SELECT id FROM public.pagamenti WHERE corsa_id=$1 FOR UPDATE', [f.rideId]);
    if (payments.rows.length !== 3 || payments.rows.some(x => !f.items.some(i => Number(i.paymentId) === Number(x.id)))) throw new Error('CLEANUP BLOCCATO: pagamenti non corrispondenti alla fixture');
    const assignments = await c.query('SELECT id,operatore_id,conducente_id,veicolo_id,modalita,stato FROM public.assegnazioni_conducenti WHERE corsa_id=$1 FOR UPDATE',[f.rideId]);
    if (!Number.isSafeInteger(f.assignmentId) || assignments.rows.length !== 1 ||
        Number(assignments.rows[0].id) !== f.assignmentId ||
        Number(assignments.rows[0].operatore_id) !== 2 ||
        Number(assignments.rows[0].conducente_id) !== 2 ||
        Number(assignments.rows[0].veicolo_id) !== 357 ||
        assignments.rows[0].modalita !== 'titolare' ||
        assignments.rows[0].stato !== 'completata') {
      throw new Error('CLEANUP BLOCCATO: assegnazione non corrispondente alla fixture');
    }
    const removedAssignment = await c.query('DELETE FROM public.assegnazioni_conducenti WHERE id=$1 AND corsa_id=$2 RETURNING id',[f.assignmentId,f.rideId]);
    if (removedAssignment.rowCount !== 1) throw new Error('CLEANUP BLOCCATO: assegnazione non eliminata');
    { const d=await c.query('DELETE FROM public.pagamenti WHERE corsa_id=$1 RETURNING id',[f.rideId]); const expected=f.items.map(i=>i.paymentId).map(Number).sort((a,b)=>a-b); const actual=d.rows.map(x=>Number(x.id)).sort((a,b)=>a-b); if(JSON.stringify(actual)!==JSON.stringify(expected)) throw new Error('CLEANUP BLOCCATO: ID pagamenti non corrispondenti'); }
    { const d=await c.query('DELETE FROM public.prenotazioni WHERE corsa_id=$1 RETURNING id',[f.rideId]); const expected=f.items.map(i=>i.prenId).map(Number).sort((a,b)=>a-b); const actual=d.rows.map(x=>Number(x.id)).sort((a,b)=>a-b); if(JSON.stringify(actual)!==JSON.stringify(expected)) throw new Error('CLEANUP BLOCCATO: ID prenotazioni non corrispondenti'); }
    { const d=await c.query('DELETE FROM public.corse_tratte WHERE corsa_id=$1 RETURNING id',[f.rideId]); const expected=[f.trattaId].map(Number).sort((a,b)=>a-b); const actual=d.rows.map(x=>Number(x.id)).sort((a,b)=>a-b); if(JSON.stringify(actual)!==JSON.stringify(expected)) throw new Error('CLEANUP BLOCCATO: ID corse_tratte non corrispondenti'); }
    await c.query('DELETE FROM public.corse WHERE id=$1',[f.rideId]);
    const deletedUsers = await c.query('DELETE FROM public.utente WHERE id = ANY($1::int[]) AND tipo=$2 AND nome LIKE $3 RETURNING id', [f.userIds, 'cliente', f.marker + '%']);
    if (deletedUsers.rowCount !== 3) throw new Error('CLEANUP BLOCCATO: numero clienti eliminati non valido');
    await c.query('COMMIT');
    f.cleaned = true;
    f.complete = true;
    saveJournal();
    console.log(`CLEANUP DB OK: corsa ${f.rideId} (PaymentIntent Stripe TEST conservati)`);
  } catch(e) { await c.query('ROLLBACK').catch(()=>{}); console.error(`CLEANUP NON RIUSCITO corsa ${f.rideId}: ${e.message}`); process.exitCode = 1; }
  finally { c.release(); }
}

try {
  const r = await pool.query('SELECT stato, origine_address FROM public.corse WHERE id=$1', [1009]);
  if (r.rows.length !== 1 || r.rows[0].stato !== 'completata' || r.rows[0].origine_address !== f.marker) throw new Error('BLOCCO: corsa non verificata');
  await cleanup(f);
  if (!f.cleaned) throw new Error('BLOCCO: pulizia non completata');
} finally { await pool.end(); }

