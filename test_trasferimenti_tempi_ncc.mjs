import { pool } from './db/db.js';
import {
  caricaImpegniVeicolo,
  verificaTrasferimentiVeicolo
} from './services/booking/vehicle-commitments.service.js';

let errori = 0;

try {
  const impegni = await caricaImpegniVeicolo(pool, 354);
  const corsa = impegni.find(i =>
    i.fonte === 'NCC' && String(i.riferimento_id) === '899'
  );

  if (!corsa || corsa.destinazione_lat == null ||
      corsa.destinazione_lon == null) {
    throw new Error('Coordinate corsa 899 mancanti');
  }

  const missione = {
    inizio: '2026-11-03T14:00:00Z',
    fine: '2026-11-03T14:30:00Z',
    origine: {
      lat: corsa.destinazione_lat,
      lon: corsa.destinazione_lon
    },
    destinazione: {
      lat: corsa.destinazione_lat,
      lon: corsa.destinazione_lon
    }
  };

  for (const caso of [
    { nome: 'Trasferimento fattibile', secondi: 600, atteso: true },
    { nome: 'Trasferimento impossibile', secondi: 3600, atteso: false }
  ]) {
    const risultato = await verificaTrasferimentiVeicolo(
      pool, 354, missione,
      {
        movement: async () => ({ seconds: caso.secondi })
      }
    );

    const ok = risultato.compatibile === caso.atteso;
    if (!ok) errori++;

    console.log(`${ok ? 'PASS' : 'FAIL'} ${caso.nome}`, {
      compatibile: risultato.compatibile,
      conflitti: risultato.conflitti.map(c => c.motivo),
      nonVerificabili: risultato.nonVerificabili.map(c => c.motivo)
    });
  }
} catch (errore) {
  console.error('TEST FALLITO:', errore);
  errori++;
} finally {
  await pool.end();
}

console.log(errori === 0
  ? 'TUTTI I TEST SUPERATI'
  : `${errori} TEST FALLITI`);

if (errori) process.exitCode = 1;
