// TURENTU — POPBUS V2
// TEST EQUIVALENZA CONFLITTI VEICOLO
//
// Confronta:
// 1. Query PostgreSQL originale dello SHADOW
// 2. Indice degli impegni in memoria
//
// REPEATABLE READ READ ONLY
// Nessuna scrittura DB
// Nessuna modifica al worker LIVE

import assert from 'node:assert/strict';
import { pool } from '../db/db.js';

import {
  caricaImpegniVeicoliShadow,
  verificaConflittoInMemoria,
} from '../services/popbus/v2/vehicle-commitments-shadow.js';

const fail = message => {
  throw new Error(`POPBUS_COMMITMENTS_EQUIVALENCE: ${message}`);
};

const client = await pool.connect();

let transactionStarted = false;

const stats = {
  veicoli: 0,
  intervalli: 0,
  confronti: 0,
  conflittiSql: 0,
  conflittiMemoria: 0,
  differenze: 0,
};

async function conflittoSql(vehicleId, start, end) {
  // Stessa logica della funzione conflicts()
  // in pixel-first-multimission-service.js.

  const { rows } = await client.query(`
    SELECT 1 AS found
    FROM popbus_attivazioni a
    WHERE a.veicolo_id = $1
      AND a.stato IN ('in_attesa_autista', 'confermata')
      AND COALESCE(
        (a.piano->>'busyStart')::timestamptz,
        a.partenza
      ) < $3::timestamptz
      AND COALESCE(
        (a.piano->>'busyEnd')::timestamptz,
        a.arrivo
      ) > $2::timestamptz

    UNION ALL

    SELECT 1
    FROM corse c
    WHERE c.veicolo_id = $1
      AND c.stato IN ('prenotabile', 'in_corso', 'da_attivare')
      AND c.start_datetime < $3::timestamptz
      AND (
        c.arrivo_datetime IS NULL
        OR c.arrivo_datetime > $2::timestamptz
      )
  `, [
    vehicleId,
    new Date(start),
    new Date(end),
  ]);

  return rows.length > 0;
}

function creaIntervalli(impegni) {
  const MINUTO = 60_000;
  const ORA = 60 * MINUTO;

  const now = Date.now();

  const intervals = [
    [now, now + ORA],
    [now + ORA, now + 2 * ORA],
    [now + 24 * ORA, now + 26 * ORA],
    [now + 7 * 24 * ORA, now + 7 * 24 * ORA + ORA],
  ];

  for (const impegno of impegni.slice(0, 20)) {
    const start = impegno.start;
    const end = impegno.end;

    // Sovrapposizione iniziale
    intervals.push([
      start - 10 * MINUTO,
      start + 10 * MINUTO,
    ]);

    // Intervallo che inizia esattamente alla partenza
    intervals.push([
      start,
      start + MINUTO,
    ]);

    if (Number.isFinite(end)) {
      // Sovrapposizione finale
      intervals.push([
        end - 10 * MINUTO,
        end + 10 * MINUTO,
      ]);

      // Adiacenza: termina esattamente all'inizio
      intervals.push([
        start - ORA,
        start,
      ]);

      // Adiacenza: inizia esattamente alla fine
      intervals.push([
        end,
        end + ORA,
      ]);

      // Intervallo che contiene tutto l'impegno
      intervals.push([
        start - MINUTO,
        end + MINUTO,
      ]);
    }
  }

  return intervals.filter(([start, end]) =>
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    end > start
  );
}

try {
  await client.query(
    'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'
  );

  transactionStarted = true;

  await client.query("SET LOCAL statement_timeout = '30s'");

  const { rows: vehicles } = await client.query(`
    SELECT DISTINCT veicolo_id AS id
    FROM (
      SELECT veicolo_id
      FROM popbus_attivazioni
      WHERE stato IN ('in_attesa_autista', 'confermata')

      UNION ALL

      SELECT veicolo_id
      FROM corse
      WHERE stato IN ('prenotabile', 'in_corso', 'da_attivare')
    ) AS impegni
    ORDER BY id
  `);

  const vehicleIds = vehicles.map(v => Number(v.id));

  if (!vehicleIds.length) {
    fail('Nessun veicolo con impegni: test non significativo');
  }

  const startedAt = performance.now();

  const indice = await caricaImpegniVeicoliShadow(
    client,
    vehicleIds
  );

  const loadingMs = performance.now() - startedAt;

  stats.veicoli = vehicleIds.length;

  for (const vehicleId of vehicleIds) {
    const impegni = indice.byVehicle.get(vehicleId);

    assert.ok(
      Array.isArray(impegni),
      `Indice mancante per veicolo ${vehicleId}`
    );

    const intervalli = creaIntervalli(impegni);

    stats.intervalli += intervalli.length;

    for (const [start, end] of intervalli) {
      const sql = await conflittoSql(vehicleId, start, end);

      const memoria = verificaConflittoInMemoria(
        indice,
        vehicleId,
        start,
        end
      );

      stats.confronti++;

      if (sql) stats.conflittiSql++;
      if (memoria) stats.conflittiMemoria++;

      if (sql !== memoria) {
        stats.differenze++;

        console.error('DIFFERENZA_CONFLITTO:', {
          vehicleId,
          start: new Date(start).toISOString(),
          end: new Date(end).toISOString(),
          sql,
          memoria,
        });

        fail(
          `Risultati differenti per veicolo ${vehicleId}`
        );
      }
    }
  }

  // Un veicolo non incluso nell'indice non deve
  // essere considerato automaticamente libero.
  assert.throws(
    () => verificaConflittoInMemoria(
      indice,
      -1,
      Date.now(),
      Date.now() + 60_000
    )
  );

  console.log(
    'POPBUS_COMMITMENTS_EQUIVALENCE_RESULT:' +
    JSON.stringify({
      passed: true,
      ...stats,
      caricamentoMs: Number(loadingMs.toFixed(2)),
      diagnosticaIndice: indice.diagnostica,
      dbWrites: 0,
    })
  );

} catch (error) {
  process.exitCode = 1;

  console.error(
    'POPBUS_COMMITMENTS_EQUIVALENCE_ERROR:',
    error.stack || error.message
  );

} finally {
  if (transactionStarted) {
    try {
      await client.query('ROLLBACK');
      console.log('POPBUS_COMMITMENTS_ROLLBACK_OK');
    } catch (error) {
      process.exitCode = 1;
      console.error('ROLLBACK_ERROR:', error.message);
    }
  }

  client.release();
  await pool.end();
}