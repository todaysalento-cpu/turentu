/**
 * Turentu NCC condivise - diagnostica d'integrazione su PostgreSQL reale.
 * SOLO LETTURA: BEGIN READ ONLY + ROLLBACK; nessun endpoint Stripe.
 * Avvio dalla root backend: node tests/test_ncc_condivise_db.mjs
 */
import 'dotenv/config';
import { pool } from '../db/db.js';

let pass = 0, fail = 0, warn = 0;
const ok = (name, detail = '') => { pass++; console.log(`  PASS ${name}${detail ? ' — ' + detail : ''}`); };
const bad = (name, detail = '') => { fail++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); };
const gap = (name, detail = '') => { warn++; console.warn(`  GAP  ${name}${detail ? ' — ' + detail : ''}`); };
const qname = s => '"' + s.replaceAll('"', '""') + '"';
const num = v => v === null || v === undefined ? NaN : Number(v);

async function main() {
  const db = await pool.connect();
  try {
    await db.query('BEGIN READ ONLY');
    await db.query("SET LOCAL statement_timeout = '15000ms'");
    console.log('\nTURENTU — TEST DB REALE CONDIVISE NCC (SOLA LETTURA)');
    const required = ['corse', 'corse_tratte', 'prenotazioni', 'pending', 'pagamenti'];
    const schemas = new Map();
    for (const table of required) {
      const r = await db.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`, [table]);
      if (!r.rowCount) { bad(`Tabella public.${table} assente`); continue; }
      schemas.set(table, new Set(r.rows.map(x => x.column_name)));
      ok(`Tabella public.${table}`, `${r.rowCount} colonne`);
    }
    const has = (t, ...cols) => cols.every(c => schemas.get(t)?.has(c));
    const count = async (label, sql, params = []) => {
      const r = await db.query(sql, params);
      const n = Number(r.rows[0].n);
      if (n === 0) ok(label, '0 anomalie'); else bad(label, `${n} anomalie`);
    };
    if (has('corse', 'id', 'tipo_corsa', 'stato')) {
      const r = await db.query("SELECT stato, COUNT(*)::int AS n FROM public.corse WHERE tipo_corsa='condivisa' GROUP BY stato ORDER BY stato");
      console.log('\nCorse condivise NCC per stato:', r.rows);
      if (!r.rows.length) gap('Nessuna corsa condivisa NCC presente: impossibile validare dati di esempio');
    } else gap('Mancano colonne necessarie in corse');

    if (has('corse', 'id', 'tipo_corsa') && has('corse_tratte', 'corsa_id')) {
      await count('Tratte NCC orfane', `SELECT COUNT(*)::int AS n FROM public.corse_tratte t LEFT JOIN public.corse c ON c.id=t.corsa_id WHERE c.id IS NULL`);
      if (has('corse_tratte', 'id', 'stato_temporale', 'partenza_prevista') && has('corse', 'stato')) {
        const r = await db.query(`SELECT COUNT(*)::int AS n FROM public.corse c JOIN public.corse_tratte t ON t.corsa_id=c.id WHERE c.tipo_corsa='condivisa' AND c.stato='prenotabile' AND t.stato_temporale IS DISTINCT FROM 'flessibile' AND t.partenza_prevista IS NOT NULL`);
        if (Number(r.rows[0].n)) ok('Tratte NCC prenotabili con orario', `${r.rows[0].n} disponibili`);
        else gap('Nessuna tratta NCC prenotabile con orario per un test di prenotazione');
      }
    }
    if (has('prenotazioni', 'corsa_id', 'tratta_id') && has('corse', 'id', 'tipo_corsa')) {
      await count('Prenotazioni NCC con tratta mancante', `SELECT COUNT(*)::int AS n FROM public.prenotazioni p JOIN public.corse c ON c.id=p.corsa_id WHERE c.tipo_corsa='condivisa' AND p.tratta_id IS NULL`);
      if (has('corse_tratte', 'id', 'corsa_id')) {
        await count('Prenotazioni NCC con tratta non appartenente alla corsa', `SELECT COUNT(*)::int AS n FROM public.prenotazioni p JOIN public.corse c ON c.id=p.corsa_id LEFT JOIN public.corse_tratte t ON t.id=p.tratta_id AND t.corsa_id=p.corsa_id WHERE c.tipo_corsa='condivisa' AND p.tratta_id IS NOT NULL AND t.id IS NULL`);
      }
    }
    if (has('pending', 'corsa_id', 'tratta_id', 'tipo_corsa') && has('corse_tratte', 'id', 'corsa_id')) {
      await count('Pending NCC con tratta incoerente', `SELECT COUNT(*)::int AS n FROM public.pending p LEFT JOIN public.corse_tratte t ON t.id=p.tratta_id AND t.corsa_id=p.corsa_id WHERE p.tipo_corsa='condivisa' AND (p.tratta_id IS NULL OR t.id IS NULL)`);
    }
    if (has('corse', 'id', 'tipo_corsa', 'prezzo_fisso', 'prenotazione_origine_id') && has('prenotazioni', 'id', 'corsa_id')) {
      await count('Corse NCC prenotate senza snapshot Modello A', `SELECT COUNT(*)::int AS n FROM public.corse c WHERE c.tipo_corsa='condivisa' AND EXISTS (SELECT 1 FROM public.prenotazioni p WHERE p.corsa_id=c.id) AND (c.prezzo_fisso IS NULL OR c.prenotazione_origine_id IS NULL)`);
      await count('Origine Modello A non appartenente alla corsa', `SELECT COUNT(*)::int AS n FROM public.corse c LEFT JOIN public.prenotazioni p ON p.id=c.prenotazione_origine_id AND p.corsa_id=c.id WHERE c.tipo_corsa='condivisa' AND c.prenotazione_origine_id IS NOT NULL AND p.id IS NULL`);
    } else gap('Colonne snapshot Modello A non tutte disponibili');
    if (has('prenotazioni', 'corsa_id', 'prezzo_totale') && has('corse', 'id', 'tipo_corsa')) {
      await count('Quote NCC negative o non valorizzate', `SELECT COUNT(*)::int AS n FROM public.prenotazioni p JOIN public.corse c ON c.id=p.corsa_id WHERE c.tipo_corsa='condivisa' AND (p.prezzo_totale IS NULL OR p.prezzo_totale < 0)`);
      const r = await db.query(`SELECT c.id AS corsa_id, COUNT(p.id)::int AS prenotazioni, c.prezzo_fisso, ROUND(SUM(p.prezzo_totale)::numeric,2) AS somma_quote FROM public.corse c JOIN public.prenotazioni p ON p.corsa_id=c.id WHERE c.tipo_corsa='condivisa' GROUP BY c.id, c.prezzo_fisso ORDER BY c.id DESC LIMIT 15`);
      console.log('\nCampione economico NCC (max 15 corse):'); console.table(r.rows);
      if (!r.rowCount) gap('Nessuna prenotazione NCC reale su cui confrontare quote');
    }
    if (has('pagamenti', 'prenotazione_id', 'stripe_payment_intent', 'stato') && has('prenotazioni', 'id', 'corsa_id') && has('corse', 'id', 'tipo_corsa')) {
      const r = await db.query(`SELECT p.stato, COUNT(*)::int AS n FROM public.pagamenti p JOIN public.prenotazioni pr ON pr.id=p.prenotazione_id JOIN public.corse c ON c.id=pr.corsa_id WHERE c.tipo_corsa='condivisa' GROUP BY p.stato ORDER BY p.stato`);
      console.log('\nPagamenti NCC per stato:', r.rows);
      if (!r.rowCount) gap('Nessun pagamento NCC nel DB: cattura e riconciliazione non verificabili');
      await count('PaymentIntent duplicati su pagamenti NCC', `SELECT COUNT(*)::int AS n FROM (SELECT p.stripe_payment_intent FROM public.pagamenti p JOIN public.prenotazioni pr ON pr.id=p.prenotazione_id JOIN public.corse c ON c.id=pr.corsa_id WHERE c.tipo_corsa='condivisa' AND p.stripe_payment_intent IS NOT NULL GROUP BY p.stripe_payment_intent HAVING COUNT(*) > 1) d`);
    }
    await db.query('ROLLBACK');
    console.log(`\nRISULTATO: ${pass} PASS | ${fail} FAIL | ${warn} GAP`);
    console.log('DB non modificato. Stripe non contattato.');
    process.exitCode = fail ? 1 : 0;
  } catch (e) {
    try { await db.query('ROLLBACK'); } catch {}
    console.error('ERRORE TEST:', e.message, e.code ? `(PostgreSQL ${e.code})` : '');
    process.exitCode = 2;
  } finally {
    db.release();
    await pool.end();
  }
}
main().catch(e => { console.error(e); process.exitCode = 2; });
