
import { pool } from '../db/db.js';
import {
  verificaSovrapposizioniVeicolo
} from '../services/booking/vehicle-commitments.service.js';

const veicoloId = 364;

const scenari = [
  {
    nome: 'Sovrapposizione',
    inizio: '2026-10-18T14:30:00+02:00',
    fine: '2026-10-18T15:00:00+02:00',
    atteso: false
  },
  {
    nome: 'Intervallo precedente',
    inizio: '2026-10-18T12:00:00+02:00',
    fine: '2026-10-18T13:00:00+02:00',
    atteso: true
  },
  {
    nome: 'Intervallo successivo',
    inizio: '2026-10-18T16:00:00+02:00',
    fine: '2026-10-18T17:00:00+02:00',
    atteso: true
  },
  {
    nome: 'Intervallo adiacente',
    inizio: '2026-10-18T15:18:00+02:00',
    fine: '2026-10-18T16:00:00+02:00',
    atteso: true
  }
];

let falliti = 0;

try {
  const client = await pool.connect();

  try {
    await client.query('BEGIN READ ONLY');

    for (const scenario of scenari) {
      const risultato = await verificaSovrapposizioniVeicolo(
        client,
        veicoloId,
        scenario.inizio,
        scenario.fine
      );

      const superato =
        risultato.disponibile === scenario.atteso;

      if (!superato) falliti++;

      console.log(
        superato ? 'PASS' : 'FAIL',
        scenario.nome,
        '| disponibile:', risultato.disponibile,
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

if (falliti > 0) {
  process.exitCode = 1;
}

console.log(
  `\nRisultato: ${scenari.length - falliti}/${scenari.length} test superati`
);
