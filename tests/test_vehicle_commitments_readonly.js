
import { pool } from '../db/db.js';
import { caricaImpegniVeicolo } from '../services/booking/vehicle-commitments.service.js';

const veicoloId = Number(process.argv[2]);

if (!Number.isSafeInteger(veicoloId) || veicoloId <= 0) {
  console.error('Uso: node tests/test_vehicle_commitments_readonly.js 366');
  process.exit(1);
}

try {
  const client = await pool.connect();

  try {
    await client.query('BEGIN READ ONLY');

    const impegni = await caricaImpegniVeicolo(
      client,
      veicoloId
    );

    console.log('\nTURENTU - IMPEGNI VEICOLO');
    console.log('Veicolo:', veicoloId);
    console.log('Impegni trovati:', impegni.length);

    console.table(
      impegni.map(i => ({
        fonte: i.fonte,
        id: i.riferimento_id,
        stato: i.stato,
        inizio: i.inizio,
        fine: i.fine
      }))
    );

    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
} catch (error) {
  console.error('TEST FALLITO:', error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
