/**
 * TURENTU P0-C7B - diagnosi READ ONLY delle fixture di accettazione multimissione.
 * Non invoca accettaAttivazione, Stripe, HTTP, socket; non modifica dati.
 * CMD: node tests\test_pixel_popbus_p0_c7b_readiness.mjs
 */
import { readFile } from 'node:fs/promises';
import { pool } from '../db/db.js';

const file = new URL('../services/popbus/v2/acceptance.js', import.meta.url);
const src = await readFile(file, 'utf8');
const checks = {
  'funzione accettaAttivazione': /export\s+async\s+function\s+accettaAttivazione\s*\(/.test(src),
  'preflight PIXEL multi collegato': /verificaAccettazionePixelMulti\s*\(\s*client\s*,/.test(src),
  'preflight missioni persistite': /verificaMissioniPersistite\s*\(/.test(src),
  'guardia flag multimissione': /POPBUS_MULTIMISSION_ACCEPTANCE_TEST/.test(src),
  'verifica pagamento': /await\s+verificaPagamento\s*\(/.test(src),
  'un solo INSERT corse nel modulo': (src.match(/INSERT\s+INTO\s+(?:public\.)?corse\s*\(/gi) || []).length === 1,
};
console.log('=== P0-C7B / AUDIT STATICO ===');
for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? 'PASS' : 'ATTENZIONE'}: ${name}`);
if (process.env.POPBUS_MULTIMISSION_ACCEPTANCE_TEST === 'true') {
  console.error('BLOCCATO: flag multimissione attivo; disabilitarlo prima del test.');
  process.exitCode = 2;
} else {
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout = '10s'");
    const {rows: candidates} = await client.query(`
      SELECT a.id AS attivazione_id, a.stato AS attivazione_stato,
             a.veicolo_id, a.autista_id, a.corsa_id,
             jsonb_array_length(a.piano->'missioni') AS missioni,
             (SELECT count(*)::int FROM public.popbus_attivazione_missioni m
              WHERE m.attivazione_id=a.id) AS missioni_db,
             (SELECT count(*)::int FROM public.popbus_attivazione_richieste ar
              WHERE ar.attivazione_id=a.id AND ar.attiva) AS richieste_db,
             (SELECT count(*)::int FROM public.offerte_autisti o
              WHERE o.attivazione_id=a.id AND o.stato='inviata' AND o.expires_at>now()) AS offerte_valide
      FROM public.popbus_attivazioni a
      WHERE jsonb_typeof(a.piano->'missioni')='array'
        AND jsonb_array_length(a.piano->'missioni')>1
      ORDER BY a.id DESC LIMIT 10
    `);
    console.log('\n=== ATTIVAZIONI MULTIMISSIONE ESISTENTI (MAX 10) ===');
    if (!candidates.length) console.log('NESSUNA: serve una fixture transazionale dedicata per P0-C7B.');
    else console.table(candidates);
    console.log('\nNessun dato modificato; nessun pagamento verificato.');
    await client.query('ROLLBACK');
  } catch(e) {
    console.error('ERRORE READ ONLY:',e.message);
    if (client) await client.query('ROLLBACK').catch(()=>{});
    process.exitCode=1;
  } finally { client?.release(); await pool.end(); }
}
