// TURENTU POPBUS V2 — Collaudo persistenza fisica in transazione con ROLLBACK.
// Salvare come tests/test_pixel_first_physical_persistence_rollback.js
// Avvio: set POPBUS_SHADOW_OPPORTUNITY_IDS=ID1,ID2
//        node --env-file=.env tests/test_pixel_first_physical_persistence_rollback.js
// Non abilita LIVE. Esegue scritture transazionali di prova, poi ROLLBACK.
// Eseguire esclusivamente su un database di test isolato, NON in produzione.

import { pool } from '../db/db.js';
import { processaPixelFirstMultimissione } from '../services/popbus/v2/pixel-first-multimission-service.js';

const assert = (ok, message) => { if (!ok) throw new Error(`PHYSICAL_PERSISTENCE_ASSERT: ${message}`); };
const positive = x => x != null && x !== '' && Number.isSafeInteger(Number(x)) && Number(x) > 0;

async function main() {
  assert(process.env.POPBUS_PIXEL_FIRST_LIVE_APPROVED !== '1', 'LIVE_APPROVED attivo');
  assert(process.env.POPBUS_PIXEL_FIRST_ENABLED !== 'true', 'scheduler PIXEL-first attivo');
  assert(process.env.TURENTU_ALLOW_PHYSICAL_PERSISTENCE_ROLLBACK_TEST === 'YES',
    'Impostare TURENTU_ALLOW_PHYSICAL_PERSISTENCE_ROLLBACK_TEST=YES solo su DB di test isolato');

  const raw = process.env.POPBUS_SHADOW_OPPORTUNITY_IDS;
  assert(raw && raw.trim(), 'Imposta POPBUS_SHADOW_OPPORTUNITY_IDS=ID1,ID2');
  const opportunityIds = raw.split(',').map(s => Number(s.trim()));
  assert(opportunityIds.length === 2 && opportunityIds.every(positive) &&
    new Set(opportunityIds).size === 2, 'Servono esattamente due ID opportunita PIXEL distinti');

  const db = await pool.query('SELECT current_database() AS name, pg_is_in_recovery() AS replica');
  assert(db.rows[0]?.name === 'corse_db', 'database diverso da corse_db');
  assert(db.rows[0]?.replica === false, 'database in recovery');

  const result = await processaPixelFirstMultimissione({
    pool,
    mode: 'ROLLBACK_ONLY',
    physicalShadow: true,
    physicalCycleShadow: true,
    physicalTransactionTest: true,
    physicalPersistenceTest: true,
    physicalOpportunityIds: opportunityIds
  });

  assert(result?.modalita === 'ROLLBACK_ONLY', 'modalita errata');
  assert(result?.selezioneFisica?.migliorCiclo,
    'nessun ciclo fisico selezionato: persistenza non collaudabile');
  assert(result?.testPersistenza?.ok === true, 'collaudo persistenza fisica V2 non riuscito');
  assert(result.testPersistenza.persistita === false, 'persistenza permanente non consentita');
  assert(result.testPersistenza.attivabile === false, 'attivazione LIVE non consentita');
  assert(result.testPersistenza.dbWrites === 0, 'scritture permanenti dichiarate');
  assert(result?.percorso === 'PIXEL_FERMATE_FISICHE_CICLI_SHADOW_V2', 'percorso fisico non eseguito');
  assert(result?.offerte === 0, 'offerte permanenti dichiarate');
  assert(result?.dbWrites === 0, 'dbWrites permanenti dichiarati');
  assert(result?.attivabile === false, 'risultato attivabile');
  assert(Array.isArray(result?.candidati), 'candidati mancanti');
  assert(Number.isSafeInteger(result?.missioniCandidateFisiche), 'conteggio non valido');
  assert(result.missioniCandidateFisiche === result.candidati.length,
    'conteggio candidati discordante');
  assert(result.candidati.every(c => c?.attivabile === false), 'candidato attivabile');
  assert(result.selezioneFisica?.shadow === true, 'selezione cicli non eseguita');
  assert(result.selezioneFisica?.attivabile === false, 'cicli attivabili');
  assert(result.selezioneFisica?.dbWrites === 0, 'scritture cicli dichiarate');

  const summary = {
    stato: 'PASS_PHYSICAL_PERSISTENCE_ROLLBACK',
    opportunita: opportunityIds,
    percorso: result.percorso,
    missioniCandidateFisiche: result.missioniCandidateFisiche,
    offerte: result.offerte,
    dbWrites: result.dbWrites,
    attivabile: result.attivabile,
    testPersistenza: result.testPersistenza,
    diagnostica: result.diagnostica,
    diagnosticaCicli: result.selezioneFisica.diagnostica,
    migliorCiclo: {
      vehicleId: result.selezioneFisica.migliorCiclo.vehicleId,
      richiestaIds: result.selezioneFisica.migliorCiclo.richiestaIds,
      economia: result.selezioneFisica.migliorCiclo.economia
    }
  };
  console.log('POPBUS_PHYSICAL_PERSISTENCE_ROLLBACK_RESULT=' + JSON.stringify(summary, null, 2));
  console.log('ATTENZIONE: questo test verifica gli esiti dichiarati dal writer; non confronta snapshot DB prima/dopo.');
} 

try {
  await main();
} catch (error) {
  console.error('POPBUS_PHYSICAL_PERSISTENCE_ROLLBACK_FAIL:', error?.stack ?? String(error));
  process.exitCode = 1;
} finally {
  await pool.end();
}
