
import { pool } from '../db/db.js';
import {
  verificaTrasferimentiVeicolo
} from '../services/booking/vehicle-commitments.service.js';

const veicoloId = 364;

// Corsa 923: termina il 18/10/2026 alle 13:18 UTC.
// Nuova missione: parte alle 14:00 UTC.
const missione = {
  inizio: '2026-10-18T14:00:00Z',
  fine: '2026-10-18T15:00:00Z',
  origine: { lat: 40.4674, lon: 17.2348 },
  destinazione: { lat: 40.3522, lon: 18.1755 }
};

const scenari = [
  { nome: 'Trasferimento 0 minuti', minuti: 0, atteso: true },
  { nome: 'Trasferimento 10 minuti', minuti: 10, atteso: true },
  { nome: 'Trasferimento 30 minuti', minuti: 30, atteso: true },
  { nome: 'Trasferimento 50 minuti', minuti: 50, atteso: false }
];

let falliti = 0;
let eseguiti = 0;

try {
  const client = await pool.connect();

  try {
    await client.query('BEGIN READ ONLY');

    for (const scenario of scenari) {
      const risultato = await verificaTrasferimentiVeicolo(
        client,
        veicoloId,
        missione,
        {
          movement: async () => ({
            metres: 1000,
            seconds: scenario.minuti * 60
          })
        }
      );

      eseguiti++;

      const superato =
        risultato.compatibile === scenario.atteso;

      if (!superato) falliti++;

      console.log(
        superato ? 'PASS' : 'FAIL',
        scenario.nome,
        '| compatibile:', risultato.compatibile,
        '| conflitti:', risultato.conflitti.length,
        '| non verificabili:', risultato.nonVerificabili.length
      );
    }

    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
} catch (error) {
  console.error('TEST FALLITO:', error);
  process.exitCode = 1;
} finally {
  await pool.end();
}

if (falliti > 0 || eseguiti !== scenari.length) {
  process.exitCode = 1;
}

console.log(
  `\nRisultato: ${eseguiti - falliti}/${scenari.length} test superati`
);
