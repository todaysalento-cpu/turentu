import 'dotenv/config';
import { pool } from '../db/db.js';
import { processaProposteDinamicheV2 } from '../services/popbus/v2/worker.js';

const REQUEST_ID = 31;

async function main() {
  console.log('=== POPBUS V2 | COLLAUDO CONTROLLATO RICHIESTA 31 ===');

  if (!process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_')) {
    throw new Error('BLOCCATO: STRIPE_SECRET_KEY non e una chiave di test');
  }
  if (process.env.POPBUS_TEST_REQUEST_ID !== undefined &&
      process.env.POPBUS_TEST_REQUEST_ID !== String(REQUEST_ID)) {
    throw new Error('BLOCCATO: POPBUS_TEST_REQUEST_ID gia impostato su altro ID');
  }
  process.env.POPBUS_TEST_REQUEST_ID = String(REQUEST_ID);

  const { rows: expired } = await pool.query(`
    SELECT COUNT(*)::int AS totale
    FROM popbus_attivazioni
    WHERE stato='in_attesa_autista' AND expires_at<=NOW()
  `);
  if (expired[0].totale !== 0) {
    throw new Error(`BLOCCATO: ${expired[0].totale} attivazioni scadute da ripulire`);
  }

  const { rows: eligible } = await pool.query(`
    SELECT r.id, r.stato, r.start_datetime, r.prezzo, r.posti_richiesti
    FROM richieste_pop_bus r
    WHERE r.id=$1 AND r.stato='in_attesa'
      AND r.start_datetime>NOW() AND r.corsa_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM popbus_attivazione_richieste ar
        WHERE ar.richiesta_id=r.id AND ar.attiva
      )
  `, [REQUEST_ID]);
  if (eligible.length !== 1) {
    throw new Error('BLOCCATO: richiesta 31 non piu idonea o gia riservata');
  }
  console.log('Preflight OK:', eligible[0]);
  console.log('Avvio UNA esecuzione del worker. Potra creare una offerta reale di test.');

  await processaProposteDinamicheV2();

  const { rows: result } = await pool.query(`
    SELECT a.id AS attivazione_id, a.veicolo_id, a.stato AS stato_attivazione,
           o.id AS offerta_id, o.stato AS stato_offerta, o.expires_at
    FROM popbus_attivazione_richieste ar
    JOIN popbus_attivazioni a ON a.id=ar.attivazione_id
    LEFT JOIN offerte_autisti o ON o.attivazione_id=a.id
    WHERE ar.richiesta_id=$1
    ORDER BY a.id DESC, o.id DESC LIMIT 3
  `, [REQUEST_ID]);
  console.log('Ultime attivazioni/offerte richiesta 31:', result);
  console.log('TEST TERMINATO: verificare gli stati prima di accettare.');
}

try {
  await main();
} catch (error) {
  console.error('TEST BLOCCATO/FALLITO:', error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
