// TURENTU FASE 5G - test LIVE fail-closed su PostgreSQL Render.
// Non crea, aggiorna o elimina dati. Non chiama Stripe: manca una attivazione valida.
// Richiede una COPIA della proposta 5E come services/popbus/v2/acceptance-fase5e-collaudo.js
// NON sostituire acceptance.js operativo e NON collegare il router.
import { Pool } from 'pg';
import { finalizzaAttivazioniAR } from '../services/popbus/v2/acceptance.js';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL mancante. Configurare la variabile in locale senza inserirla nel codice.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: true },
  max: 1,
  connectionTimeoutMillis: 10000,
  statement_timeout: 15000,
  query_timeout: 20000,
  application_name: 'turentu-fase5g-failclosed'
});

try {
  const client = await pool.connect();
  let inesistente;
  try {
    // Non usa MAX(id)+1: scegliamo un ID positivo sicuramente assente.
    const { rows } = await client.query(`
      SELECT candidate.id::bigint AS id
      FROM generate_series(2147483000::bigint, 2147483010::bigint) AS candidate(id)
      WHERE NOT EXISTS (SELECT 1 FROM popbus_attivazioni a WHERE a.id = candidate.id)
      ORDER BY candidate.id LIMIT 1
    `);
    if (!rows.length) throw new Error('Impossibile selezionare un ID di prova inesistente');
    inesistente = Number(rows[0].id);
  } finally { client.release(); }

  let rejected = false;
  try {
    await finalizzaAttivazioniAR(pool, inesistente);
  } catch (error) {
    rejected = true;
    console.log('OK: finalizzatore ha rifiutato attivazione inesistente');
    console.log('Motivo:', error.code || error.message);
  }
  if (!rejected) throw new Error('ERRORE: finalizzatore ha confermato attivazione inesistente');

  // Il pool ha max:1: questa query riesce solo se il client è stato rilasciato.
  const { rows: [health] } = await pool.query('SELECT 1 AS ok');
  if (Number(health.ok) !== 1) throw new Error('Connessione non riutilizzabile');
  console.log('OK: connessione rilasciata dopo il rifiuto');
  console.log('FASE 5G LIVE FAIL-CLOSED: 2/2 controlli superati. NESSUNA SCRITTURA.');
} finally {
  await pool.end();
}
