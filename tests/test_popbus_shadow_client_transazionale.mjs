// Copiare in tests/test_popbus_shadow_client_transazionale.mjs
// Smoke test del client condiviso: NON aggiunge richieste e NON attiva corse.
import { pool } from '../db/db.js';
import { processaPixelFirstMultimissione } from '../services/popbus/v2/pixel-first-multimission-service.js';

const opportunityIds = process.argv.slice(2).map(Number);
if (!opportunityIds.length || opportunityIds.length > 15 ||
    opportunityIds.some(id => !Number.isSafeInteger(id) || id <= 0) ||
    new Set(opportunityIds).size !== opportunityIds.length) {
  console.error('Uso: node tests/test_popbus_shadow_client_transazionale.mjs 118 119');
  process.exitCode = 2;
} else {
  let client;
  let begun = false;
  try {
    client = await pool.connect();
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ WRITE');
    begun = true;
    await client.query("SET LOCAL lock_timeout = '5s'");
    // Non imponiamo statement_timeout corto: il routing fisico puo' richiedere tempo.
    const result = await processaPixelFirstMultimissione({
      externalClient: client,
      mode: 'ROLLBACK_ONLY',
      physicalShadow: true,
      physicalCycleShadow: true,
      physicalStrategyShadow: true,
      physicalOpportunityIds: opportunityIds,
      now: Date.now()
    });
    if (result.offerte !== 0 || result.dbWrites !== 0 || result.attivabile !== false)
      throw new Error('Invarianti SHADOW violate');
    console.log('POPBUS_SHADOW_CLIENT_ESTERNO_OK', JSON.stringify({
      percorso: result.percorso,
      opportunita: opportunityIds,
      missioniCandidateFisiche: result.missioniCandidateFisiche,
      diagnosticaFisica: result.diagnostica,
      offerte: result.offerte,
      dbWrites: result.dbWrites,
      attivabile: result.attivabile,
      selezioneFisica: result.selezioneFisica,
      confrontoStrategie: result.confrontoStrategie,
      diagnosticaConflittiSnapshot: result.diagnosticaConflittiSnapshot
    }, null, 2));
  } catch (err) {
    process.exitCode = 1;
    console.error('POPBUS_SHADOW_CLIENT_ESTERNO_FAIL', err?.stack ?? err);
  } finally {
    if (client) {
      try { if (begun) await client.query('ROLLBACK'); }
      catch (e) { process.exitCode = 1; console.error('ROLLBACK_FAIL', e); }
      finally { client.release(); }
    }
    await pool.end();
  }
}
