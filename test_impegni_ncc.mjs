import { pool } from './db/db.js';
import { caricaImpegniVeicolo } from './services/booking/vehicle-commitments.service.js';

try {
  for (const veicoloId of [354, 346]) {
    const impegni = await caricaImpegniVeicolo(pool, veicoloId);

    console.log(`\nVEICOLO ${veicoloId}`);

    console.table(impegni.map(i => ({
      fonte: i.fonte,
      corsa: i.riferimento_id,
      stato: i.stato,
      inizio: i.inizio,
      fine: i.fine,
      inizio_missione: i.inizio_missione,
      fine_missione: i.fine_missione
    })));
  }
} catch (errore) {
  console.error('TEST FALLITO:', errore);
  process.exitCode = 1;
} finally {
  await pool.end();
}
