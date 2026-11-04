// TURENTU NCC â€” INTEGRAZIONE REALE POSTGRESQL + STRIPE TEST
// Salva come tests/test_ncc_stripe_integrato_reale.mjs
// Esegui: node tests/test_ncc_stripe_integrato_reale.mjs
// ATTENZIONE: scrive su PostgreSQL e crea/cattura pagamenti Stripe TEST.
// NON usare su database operativo. Usa SOLO sk_test_.
// Scenari: 1) cattura A+B+C; 2) A gia catturato, riconcilia e cattura B+C.
// Su errore mantiene i record per diagnosi/ripresa. Non cancella oggetti Stripe.
import 'dotenv/config';
import Stripe from 'stripe';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { pool } from '../db/db.js';
import { toggleCorsa } from '../services/corsa/corse.service.js';

const journalPath = process.cwd() + '/tests/TURENTU_NCC_STRIPE_TEST_1793727619493_18236.journal.json';
const journal = JSON.parse(requireJournal());
function requireJournal(){return readFileSync(journalPath,'utf8')}
function saveJournal(){writeFileSync(journalPath+'.tmp',JSON.stringify(journal,null,2));renameSync(journalPath+'.tmp',journalPath)}
async function cleanup(f) {
  // Cancella esclusivamente le fixture marcate dal test, in ordine FK.
  // Se uno scenario non e completo, preserva i dati per riconciliazione.
  if (!f.complete) return;
  if (!Array.isArray(f.userIds) || f.userIds.length !== 3 || new Set(f.userIds).size !== 3) throw new Error('CLEANUP BLOCCATO: clienti sintetici non identificati');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const ride = await c.query('SELECT origine_address FROM public.corse WHERE id=$1 FOR UPDATE',[f.rideId]);
    if (ride.rows[0]?.origine_address !== f.marker) throw new Error('Marker differente: pulizia bloccata');
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
        Number(assignments.rows[0].conducente_id) !== 9 ||
        Number(assignments.rows[0].veicolo_id) !== 357 ||
        assignments.rows[0].modalita !== 'manuale' ||
        assignments.rows[0].stato !== 'completata') {
      throw new Error('CLEANUP BLOCCATO: assegnazione non corrispondente alla fixture');
    }
    const removedAssignment = await c.query('DELETE FROM public.assegnazioni_conducenti WHERE id=$1 AND corsa_id=$2 RETURNING id',[f.assignmentId,f.rideId]);
    if (removedAssignment.rowCount !== 1) throw new Error('CLEANUP BLOCCATO: assegnazione non eliminata');
    await c.query('DELETE FROM public.pagamenti WHERE corsa_id=$1',[f.rideId]);
    await c.query('DELETE FROM public.prenotazioni WHERE corsa_id=$1',[f.rideId]);
    await c.query('DELETE FROM public.corse_tratte WHERE corsa_id=$1',[f.rideId]);
    await c.query('DELETE FROM public.corse WHERE id=$1',[f.rideId]);
    const deletedUsers = await c.query('DELETE FROM public.utente WHERE id = ANY($1::int[]) AND tipo=$2 AND nome LIKE $3 RETURNING id', [f.userIds, 'cliente', f.marker + '%']);
    if (deletedUsers.rowCount !== 3) throw new Error('CLEANUP BLOCCATO: numero clienti eliminati non valido');
    await c.query('COMMIT');
    f.cleaned = true;
    saveJournal();
    console.log(`CLEANUP DB OK: corsa ${f.rideId} (PaymentIntent Stripe TEST conservati)`);
  } catch(e) { await c.query('ROLLBACK').catch(()=>{}); console.error(`CLEANUP NON RIUSCITO corsa ${f.rideId}: ${e.message}`); process.exitCode = 1; }
  finally { c.release(); }
}
const f=journal.fixtures.find(x=>x.rideId===1025&&x.scenario==='RICONCILIA');
if(!f||f.cleaned||f.marker!=='TURENTU_NCC_STRIPE_TEST_1793727619493_18236_RICONCILIA')throw Error('Fixture non valida');
const check=await pool.query("SELECT c.id,c.stato AS corsa,a.stato AS assegnazione,a.conducente_id,count(p.id)::int AS pagamenti,count(p.id) FILTER (WHERE p.stato=$3)::int AS pagati FROM public.corse c JOIN public.assegnazioni_conducenti a ON a.corsa_id=c.id JOIN public.pagamenti p ON p.corsa_id=c.id WHERE c.id=$1 AND c.origine_address=$2 GROUP BY c.id,c.stato,a.stato,a.conducente_id",[1025,f.marker,"pagato"]);const x=check.rows[0];if(!x||x.corsa!=='completata'||x.assegnazione!=='completata'||Number(x.conducente_id)!==9||x.pagamenti!==3||x.pagati!==3)throw Error('BLOCCO: stato fixture non valido');
console.log('FIXTURE 1025 VERIFICATA: avvio cleanup protetto');
f.complete=true;
try { await cleanup(f); } finally {  }
if(!f.cleaned)throw Error('CLEANUP NON COMPLETATO');
await pool.end();