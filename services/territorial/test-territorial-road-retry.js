
import { pool } from '../../db/db.js';

import {
  ErroreRouting,
  eseguiRoutingConRetry
} from './territorial-road-retry.service.js';

async function eseguiTest(nome, routing, atteso, opzioni = {}) {
  const risultato = await eseguiRoutingConRetry({
    routing,
    timeoutMs: 100,
    ritardoBaseMs: 10,
    ...opzioni
  });

  if (
    risultato.successo !== atteso.successo ||
    risultato.tentativi !== atteso.tentativi
  ) {
    throw new Error(
      `${nome}: risultato inatteso ${JSON.stringify(risultato)}`
    );
  }

  if (
    atteso.stato &&
    risultato.risultato?.stato !== atteso.stato
  ) {
    throw new Error(`${nome}: stato non corretto`);
  }

  if (
    atteso.entro15 !== undefined &&
    risultato.risultato?.entro_15_minuti !== atteso.entro15
  ) {
    throw new Error(`${nome}: classificazione temporale errata`);
  }

  if (
    atteso.errore &&
    risultato.errore?.codice !== atteso.errore
  ) {
    throw new Error(`${nome}: errore non corretto`);
  }

  console.log(`OK - ${nome}: ${risultato.tentativi} tentativo/i`);
}

try {
  console.log('=== TEST RETRY STRADALE ===');

  const prima = await pool.query(`
    SELECT
      (SELECT COUNT(*)
       FROM territorial_hub_coda_stradale
       WHERE scenario_km=15 AND stato='in_attesa') AS coda,
      (SELECT COUNT(*)
       FROM territorial_hub_matrice_stradale) AS matrice
  `);

  // 1. Percorso entro 15 minuti.
  await eseguiTest(
    'Percorso entro 15 minuti',
    async () => ({
      stato: 'raggiungibile',
      distanza_m: 5000,
      durata_s: 600
    }),
    {
      successo: true,
      tentativi: 1,
      stato: 'raggiungibile',
      entro15: true
    }
  );

  // 2. Percorso oltre 15 minuti.
  await eseguiTest(
    'Percorso oltre 15 minuti',
    async () => ({
      stato: 'raggiungibile',
      distanza_m: 18000,
      durata_s: 1200
    }),
    {
      successo: true,
      tentativi: 1,
      stato: 'raggiungibile',
      entro15: false
    }
  );

  // 3. Nessun percorso automobilistico.
  await eseguiTest(
    'Percorso non raggiungibile',
    async () => ({
      stato: 'non_raggiungibile'
    }),
    {
      successo: true,
      tentativi: 1,
      stato: 'non_raggiungibile',
      entro15: false
    }
  );

  // 4. Timeout ripetuto.
  await eseguiTest(
    'Timeout',
    async ({ signal }) => new Promise((_, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Risposta troppo lenta'));
      }, 500);

      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new ErroreRouting('TIMEOUT_ROUTING'));
      }, { once: true });
    }),
    {
      successo: false,
      tentativi: 3,
      errore: 'TIMEOUT_ROUTING'
    }
  );

  // 5. Errore temporaneo seguito da successo.
  await eseguiTest(
    'Errore temporaneo recuperato',
    async ({ tentativo }) => {
      if (tentativo < 3) {
        throw new ErroreRouting('PROVIDER_UNAVAILABLE');
      }

      return {
        stato: 'raggiungibile',
        distanza_m: 7000,
        durata_s: 850
      };
    },
    {
      successo: true,
      tentativi: 3,
      stato: 'raggiungibile',
      entro15: true
    }
  );

  // 6. Errore definitivo: nessun retry.
  await eseguiTest(
    'Errore definitivo',
    async () => {
      throw new ErroreRouting('INVALID_REQUEST');
    },
    {
      successo: false,
      tentativi: 1,
      errore: 'INVALID_REQUEST'
    }
  );

  const dopo = await pool.query(`
    SELECT
      (SELECT COUNT(*)
       FROM territorial_hub_coda_stradale
       WHERE scenario_km=15 AND stato='in_attesa') AS coda,
      (SELECT COUNT(*)
       FROM territorial_hub_matrice_stradale) AS matrice
  `);

  if (
    prima.rows[0].coda !== dopo.rows[0].coda ||
    prima.rows[0].matrice !== dopo.rows[0].matrice
  ) {
    throw new Error('Database modificato durante il test');
  }

  console.log('\nTEST RETRY SUPERATO');
  console.log('Google: 0 chiamate');
  console.log('Database: nessuna scrittura');

} catch (error) {
  console.error('TEST FALLITO:', error.message);
  process.exitCode = 1;

} finally {
  await pool.end();
}
