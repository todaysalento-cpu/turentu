
import 'dotenv/config';

import { pool } from '../db/db.js';
import { processaProposteDinamicheV2 } from '../services/popbus/v2/worker.js';

async function main() {
  console.log('====================================');
  console.log('TURENTU POPBUS V2');
  console.log('COLLAUDO REALE - SINGOLA ESECUZIONE');
  console.log('====================================');

  if (!process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_')) {
    throw new Error('Bloccato: Stripe non è in modalità test');
  }

  const { rows } = await pool.query(`
    SELECT r.id
    FROM richieste_pop_bus r
    WHERE r.stato = 'in_attesa'
      AND r.start_datetime > NOW()
      AND r.corsa_id IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM popbus_attivazione_richieste ar
        WHERE ar.richiesta_id = r.id
          AND ar.attiva
      )
    ORDER BY r.start_datetime, r.id
  `);

  const ids = rows.map(r => Number(r.id));

  if (
    ids.length !== 2 ||
    ids[0] !== 39 ||
    ids[1] !== 40
  ) {
    throw new Error(
      `Richieste inattese: ${JSON.stringify(ids)}`
    );
  }

  console.log('Richieste verificate:', ids);
  console.log('Avvio singolo ciclo POPBUS V2...');

  await processaProposteDinamicheV2();

  console.log('Ciclo POPBUS V2 terminato.');
}

try {
  await main();
} catch (err) {
  console.error('ERRORE:', err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
