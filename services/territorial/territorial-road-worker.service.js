
import { pool } from '../../db/db.js';

import {
  classificaRisultato
} from './territorial-road-results.service.js';

const CONFIG = Object.freeze({
  scenarioKm: 15,
  batchSize: 5,
  timeoutMs: 10000,
  maxTentativi: 3,
  sogliaSecondi: 900,
  budgetGoogle: 0
});

function attendi(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function simulaRouting(riga) {
  // Risultati sintetici e deterministici.
  // Non rappresentano percorsi stradali reali.
  const distanza = Math.round(
    Number(riga.distanza_geografica_m)
  );

  const distanzaStradale = Math.round(distanza * 1.35);
  const durata = Math.round(distanzaStradale / 8.33);

  return {
    stato: 'raggiungibile',
    distanza_m: distanzaStradale,
    durata_s: durata
  };
}

async function eseguiConTimeout(operazione, timeoutMs) {
  let timer;

  try {
    return await Promise.race([
      operazione(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('TIMEOUT_ROUTING')),
          timeoutMs
        );
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function eseguiWorkerTerritoriale({
  simulazione = false,
  batchSize = CONFIG.batchSize
} = {}) {
  if (simulazione !== true) {
    throw new Error(
      'Worker reale disabilitato: consentita solo simulazione'
    );
  }

  if (
    !Number.isInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > CONFIG.batchSize
  ) {
    throw new Error('Batch non valido: massimo 5');
  }

  // Sola lettura: nessun UPDATE e nessun COMMIT.
  const query = await pool.query(`
    SELECT
      id,
      centro_gid,
      hub_id,
      distanza_geografica_m,
      priorita,
      tentativi
    FROM territorial_hub_coda_stradale
    WHERE scenario_km = $1
      AND stato = 'in_attesa'
      AND tentativi < $2
    ORDER BY priorita, distanza_geografica_m, id
    LIMIT $3
  `, [
    CONFIG.scenarioKm,
    CONFIG.maxTentativi,
    batchSize
  ]);

  const risultati = [];

  for (const riga of query.rows) {
    const inizio = Date.now();

    try {
      const risposta = await eseguiConTimeout(
        async () => {
          await attendi(20);
          return simulaRouting(riga);
        },
        CONFIG.timeoutMs
      );

      const classificazione = classificaRisultato(risposta);

      risultati.push({
        id: String(riga.id),
        centro_gid: riga.centro_gid,
        hub_id: String(riga.hub_id),
        priorita: riga.priorita,
        distanza_geografica_m:
          Number(riga.distanza_geografica_m),
        ...classificazione,
        tempo_elaborazione_ms: Date.now() - inizio,
        persistito: false
      });

    } catch (error) {
      risultati.push({
        id: String(riga.id),
        errore: error.message,
        persistito: false
      });
    }
  }

  return {
    modalita: 'simulazione',
    scenario_km: CONFIG.scenarioKm,
    batch_size: batchSize,
    verifiche_lette: query.rows.length,
    risultati,
    chiamate_google: 0,
    scritture_database: 0
  };
}
