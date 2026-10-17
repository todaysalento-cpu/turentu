// TURENTU — PREFLIGHT SICUREZZA TEST CONCORRENZA CON COMMIT
// Copiare in tests/test_ncc_preflight_commit.mjs
// SOLO LETTURA. Non crea record, non esegue COMMIT, non contatta Stripe.
import { pool } from '../db/db.js';

try {
  const { rows: [db] } = await pool.query(`
    SELECT current_database() AS database,
           current_user AS db_user,
           inet_server_addr()::text AS server_ip,
           inet_server_port() AS server_port,
           current_setting('transaction_read_only') AS read_only,
           current_setting('server_version') AS postgres_version
  `);
  const { rows: [counts] } = await pool.query(`
    SELECT (SELECT COUNT(*)::int FROM public.corse) AS corse,
           (SELECT COUNT(*)::int FROM public.corse_tratte) AS tratte,
           (SELECT COUNT(*)::int FROM public.prenotazioni) AS prenotazioni
  `);
  const { rows: [available] } = await pool.query(`
    SELECT COUNT(*)::int AS veicoli_idonei
    FROM public.veicolo v
    WHERE v.posti_totali >= 2
      AND EXISTS (SELECT 1 FROM public.tariffe t
                  WHERE t.veicolo_id=v.id AND t.tipo='standard' AND t.euro_km>0)
  `);
  const { rows: [user] } = await pool.query('SELECT COUNT(*)::int AS utenti FROM public.utente');
  console.log('\nTURENTU — PREFLIGHT TEST COMMIT (SOLA LETTURA)');
  console.table([db]);
  console.table([{...counts, ...available, ...user}]);
  if (!available.veicoli_idonei || !user.utenti) {
    console.log('GAP: mancano veicolo idoneo o utente per FK. Nessuna modifica effettuata.');
    process.exitCode = 2;
  } else {
    console.log('PRECHECK TECNICO OK. Verificare che database e server siano ESCLUSIVAMENTE di collaudo.');
  }
  console.log('Nessuna scrittura, nessun COMMIT, nessuna chiamata Stripe.');
} catch (err) {
  console.error('ERRORE PREFLIGHT:', err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
