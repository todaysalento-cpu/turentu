import { pool } from './db/db.js';
import { verificaSovrapposizioniVeicolo } from './services/booking/vehicle-commitments.service.js';

const casi = [
  {
    nome: '899 - sovrapposizione',
    veicolo: 354,
    inizio: '2026-11-03T13:10:00Z',
    fine: '2026-11-03T13:20:00Z',
    atteso: false
  },
  {
    nome: '899 - intervallo libero',
    veicolo: 354,
    inizio: '2026-11-03T15:00:00Z',
    fine: '2026-11-03T15:30:00Z',
    atteso: true
  },
  {
    nome: '920 - sovrapposizione',
    veicolo: 346,
    inizio: '2026-11-16T20:00:00Z',
    fine: '2026-11-16T20:30:00Z',
    atteso: false
  },
  {
    nome: '920 - intervallo libero',
    veicolo: 346,
    inizio: '2026-11-16T23:00:00Z',
    fine: '2026-11-16T23:30:00Z',
    atteso: true
  }
];

let errori = 0;

try {
  for (const caso of casi) {
    const risultato = await verificaSovrapposizioniVeicolo(
      pool, caso.veicolo, caso.inizio, caso.fine
    );

    const ok = risultato.disponibile === caso.atteso;
    if (!ok) errori++;

    console.log(
      `${ok ? 'PASS' : 'FAIL'} ${caso.nome}`,
      {
        disponibile: risultato.disponibile,
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

console.log(errori === 0 ? 'TUTTI I TEST SUPERATI' : `${errori} TEST FALLITI`);
if (errori) process.exitCode = 1;
