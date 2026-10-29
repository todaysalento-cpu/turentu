
import { pool } from '../db/db.js';
import {
  bloccaVeicoloPerAssegnazione
} from '../services/booking/vehicle-commitments.service.js';

const veicoloId = 364;

let clientA;
let clientB;
let transazioneA = false;
let transazioneB = false;
let superato = false;

try {
  clientA = await pool.connect();
  clientB = await pool.connect();

await clientA.query('BEGIN');
  transazioneA = true;

await clientA.query('BEGIN');
  transazioneB = true;

  await clientB.query("SET LOCAL lock_timeout = '1000ms'");
const timeoutCheck = await clientB.query(
  'SHOW lock_timeout'
);

console.log(
  'Timeout connessione B:',
  timeoutCheck.rows[0].lock_timeout
);
await clientB.query(
  "SET LOCAL statement_timeout = '3000ms'"
);

  console.log('A: acquisizione blocco veicolo');

  await bloccaVeicoloPerAssegnazione(
    clientA,
    veicoloId
  );

  console.log('A: blocco acquisito');

  console.log('B: tentativo concorrente');

  try {
    await bloccaVeicoloPerAssegnazione(
      clientB,
      veicoloId
    );

    console.error(
      'FAIL: B ha acquisito il blocco mentre A lo deteneva'
    );
  } catch (error) {
    if (error.code === '55P03') {
      console.log(
        'PASS: PostgreSQL ha impedito il secondo blocco'
      );
      superato = true;
    } else {
      throw error;
    }
  }
} catch (error) {
  console.error('TEST FALLITO:', error);
} finally {
  if (clientB) {
    if (transazioneB) {
      try {
        await clientB.query('ROLLBACK');
      } catch {}
    }
    clientB.release();
  }

  if (clientA) {
    if (transazioneA) {
      try {
        await clientA.query('ROLLBACK');
      } catch {}
    }
    clientA.release();
  }

  await pool.end();
}

console.log(
  superato
    ? '\nRisultato: TEST SUPERATO'
    : '\nRisultato: TEST FALLITO'
);

if (!superato) {
  process.exitCode = 1;
}
