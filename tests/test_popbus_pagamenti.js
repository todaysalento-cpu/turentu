
import 'dotenv/config';
import { pool } from '../db/db.js';
import { verificaPagamento } from '../services/popbus/v2/acceptance.js';

const IDS = [39, 40];

async function main() {
  const client = await pool.connect();

  try {
    console.log('====================================');
    console.log('TURENTU POPBUS V2');
    console.log('TEST AUTORIZZAZIONI PAGAMENTI');
    console.log('MODALITÀ SOLA LETTURA');
    console.log('====================================');

    if (!process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_')) {
      throw new Error(
        'Test bloccato: STRIPE_SECRET_KEY non è una chiave test'
      );
    }

    const { rows } = await client.query(
      `SELECT *
       FROM richieste_pop_bus
       WHERE id = ANY($1::int[])
       ORDER BY id`,
      [IDS]
    );

    if (rows.length !== IDS.length) {
      throw new Error('Una o più richieste non sono presenti');
    }

    for (const r of rows) {
      try {
        const risultato = await verificaPagamento(client, r);

        console.log(
          `✅ Richiesta ${r.id}: ${risultato}`
        );
      } catch (err) {
        console.error(
          `❌ Richiesta ${r.id}: ${err.message}`
        );
      }
    }

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error('❌ TEST FALLITO:', err.message);
  process.exitCode = 1;
});
