
import { pool } from '../db/db.js';
import {
  collaudaPixelFirstFisicoInTransazione
} from '../services/popbus/v2/pixel-first-multimission-service.js';

const OPPORTUNITA = 322;
const RICHIESTE_AMMESSE = new Set([562, 563, 564, 565, 566, 567]);

let client;
let transactionOpen = false;
let failed = false;
let activationId = null;
let offerId = null;

try {
  if (
    process.env.POPBUS_PIXEL_FIRST === '1' ||
    process.env.POPBUS_PIXEL_FIRST_ENABLED === 'true' ||
    process.env.POPBUS_PIXEL_FIRST_LIVE_APPROVED === '1'
  ) {
    throw new Error('PIXEL-first LIVE deve essere disabilitato');
  }

  client = await pool.connect();

  const identity = await client.query(
    'SELECT current_database() AS db, pg_is_in_recovery() AS replica'
  );

  if (identity.rows[0]?.db !== 'corse_db' ||
      identity.rows[0]?.replica !== false) {
    throw new Error('Database inatteso');
  }

  await client.query(
    'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ WRITE'
  );
  transactionOpen = true;

  await client.query("SET LOCAL lock_timeout = '5s'");
  await client.query("SET LOCAL statement_timeout = '180s'");
  await client.query(
    "SET LOCAL idle_in_transaction_session_timeout = '240000'"
  );

  console.log('PIXEL322_E2E_INIZIO');

  const result = await collaudaPixelFirstFisicoInTransazione({
    client,
    now: Date.now(),
    opportunityIds: [OPPORTUNITA]
  });

  console.log('FASE:', result.fase);
  console.log('CANDIDATI_FISICI:', result.candidatiFisici ?? 0);
  console.log('MOTIVO:', result.motivo ?? 'nessuno');

  if (
    result.fase !== 'PERSISTENZA_SIMULATA' ||
    result.testPersistenza?.ok !== true
  ) {
    throw new Error(
      'Persistenza non raggiunta: ' +
      JSON.stringify({
        fase: result.fase,
        motivo: result.motivo,
        diagnosticaSelezione: result.diagnosticaSelezione,
        diagnosticaEconomica: result.diagnosticaEconomica
      })
    );
  }

  const ids = result.ciclo?.richiestaIds ?? [];

  if (
    !ids.length ||
    ids.some(id => !RICHIESTE_AMMESSE.has(Number(id)))
  ) {
    throw new Error('Ciclo contiene richieste estranee a PIXEL 322');
  }

  activationId = Number(result.testPersistenza.attivazioneIdSimulata);
  offerId = Number(result.testPersistenza.offertaIdSimulata);

  if (!Number.isSafeInteger(activationId) || activationId <= 0 ||
      !Number.isSafeInteger(offerId) || offerId <= 0) {
    throw new Error('ID simulati non validi');
  }

  console.log('CICLO:', JSON.stringify(result.ciclo));
  console.log('ATTIVAZIONE_SIMULATA:', activationId);
  console.log('OFFERTA_SIMULATA:', offerId);

  console.log('PIXEL322_PERSISTENZA_E2E_OK');

} catch (error) {
  failed = true;
  console.error('PIXEL322_PERSISTENZA_E2E_FAIL:', error.stack ?? error);

} finally {
  if (client) {
    try {
      if (transactionOpen) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        console.log('ROLLBACK_COMPLETATO');

        if (activationId !== null && offerId !== null) {
          const a = await client.query(
            'SELECT count(*)::int AS n FROM popbus_attivazioni WHERE id=$1',
            [activationId]
          );
          const o = await client.query(
            'SELECT count(*)::int AS n FROM offerte_autisti WHERE id=$1',
            [offerId]
          );

          if (a.rows[0].n !== 0 || o.rows[0].n !== 0) {
            throw new Error('Residui dopo ROLLBACK');
          }

          console.log('ZERO_RESIDUI_OK');
        }
      }
    } catch (error) {
      failed = true;
      console.error('ROLLBACK_FAIL:', error.stack ?? error);
    } finally {
      client.release();
    }
  }

  await pool.end();
}

if (failed) process.exitCode = 1;
