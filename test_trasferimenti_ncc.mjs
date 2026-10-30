import { pool } from './db/db.js';
import {
  caricaImpegniVeicolo,
  verificaTrasferimentiVeicolo
} from './services/booking/vehicle-commitments.service.js';

let errori = 0;

try {
  for (const veicoloId of [354, 346]) {
    const impegni = await caricaImpegniVeicolo(pool, veicoloId);
    const riferimento = impegni.find(i =>
      i.fonte === 'NCC' &&
      i.inizio &&
      i.fine &&
      i.origine_lat != null &&
      i.destinazione_lat != null
    );

    if (!riferimento) {
      console.log(`SKIP veicolo ${veicoloId}: riferimento non disponibile`);
      continue;
    }

    const inizio = new Date(
      new Date(riferimento.inizio).getTime() + 5 * 60000
    );
    const fine = new Date(inizio.getTime() + 10 * 60000);

    const risultato = await verificaTrasferimentiVeicolo(
      pool,
      veicoloId,
      {
        inizio,
        fine,
        origine: {
          lat: riferimento.origine_lat,
          lon: riferimento.origine_lon
        },
        destinazione: {
          lat: riferimento.destinazione_lat,
          lon: riferimento.destinazione_lon
        }
      },
      {
        movement: async () => ({
          seconds: 0
        })
      }
    );

    const ok = risultato.compatibile === false &&
      risultato.conflitti.some(c => c.motivo === 'SOVRAPPOSIZIONE');

    if (!ok) errori++;

    console.log(
      `${ok ? 'PASS' : 'FAIL'} veicolo ${veicoloId} - trasferimento con sovrapposizione`,
      {
        compatibile: risultato.compatibile,
        conflitti: risultato.conflitti.length,
        nonVerificabili: risultato.nonVerificabili.length
      }
    );
  }
} catch (errore) {
  console.error('TEST FALLITO:', errore);
  errori++;
} finally {
  await pool.end();
}

console.log(errori === 0
  ? 'TEST COMPLETATO SENZA ERRORI'
  : `${errori} TEST FALLITI`);

if (errori) process.exitCode = 1;
