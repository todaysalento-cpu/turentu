// TURENTU POPBUS V2 — Test due opportunita PIXEL, cicli fisici SHADOW, sola lettura.
// Installare come tests/test_pixel_first_physical_shadow_readonly.mjs
// Avviare: node --env-file=.env tests/test_pixel_first_physical_shadow_readonly.mjs
// Obbligatorio: set POPBUS_SHADOW_OPPORTUNITY_IDS=118,ALTRO_ID
// NON abilita LIVE, NON esegue persistenza. Il PASS attesta solo sicurezza e diagnostica.

import { pool } from '../db/db.js';
import { processaPixelFirstMultimissione } from '../services/popbus/v2/pixel-first-multimission-service.js';

const assert = (ok, message) => { if (!ok) throw new Error(`SHADOW_PHYSICAL_ASSERT: ${message}`); };
const positive = x => x != null && x !== '' && Number.isSafeInteger(Number(x)) && Number(x) > 0;

async function main() {
  assert(process.env.POPBUS_PIXEL_FIRST_LIVE_APPROVED !== '1', 'LIVE_APPROVED attivo');
  assert(process.env.POPBUS_PIXEL_FIRST_ENABLED !== 'true', 'scheduler PIXEL-first attivo');
  const raw = process.env.POPBUS_SHADOW_OPPORTUNITY_IDS;
  assert(raw && raw.trim(), 'Imposta POPBUS_SHADOW_OPPORTUNITY_IDS=ID1,ID2');
  const opportunityIds = raw.split(',').map(s => Number(s.trim()));
  assert(opportunityIds.length === 2 && opportunityIds.every(positive) &&
    new Set(opportunityIds).size === 2, 'Servono esattamente due ID opportunita PIXEL distinti');

  // Il servizio apre internamente una transazione REPEATABLE READ READ ONLY.
  // Qui usiamo una query di sola lettura anche per la verifica del database.
  const db = await pool.query('SELECT current_database() AS name, pg_is_in_recovery() AS replica');
  assert(db.rows[0]?.name === 'corse_db', 'database diverso da corse_db');

  const result = await processaPixelFirstMultimissione({
    pool,
    mode: 'ROLLBACK_ONLY',
    physicalShadow: true,
    physicalCycleShadow: true,
    physicalTransactionTest: true,
    physicalOpportunityIds: opportunityIds
  });

  assert(result?.modalita === 'ROLLBACK_ONLY', 'modalita errata');
  assert(result?.selezioneFisica?.migliorCiclo, 'nessun ciclo fisico selezionato: test transazionale non certificabile');
  assert(result?.testTransazionale?.ok === true, 'writer fisico V2 non eseguito correttamente');
  assert(result.testTransazionale.persistita === false, 'persistenza non consentita');
  assert(result.testTransazionale.attivabile === false, 'attivazione non consentita');
  assert(result.testTransazionale.dbWrites === 0, 'scritture non consentite');
  assert(result?.percorso === 'PIXEL_FERMATE_FISICHE_CICLI_SHADOW_V2', 'percorso fisico non eseguito');
  assert(result?.offerte === 0, 'offerte non nulle');
  assert(result?.dbWrites === 0, 'dbWrites non nullo');
  assert(result?.attivabile === false, 'risultato attivabile');
  assert(Array.isArray(result?.candidati), 'candidati mancanti');
  assert(Number.isSafeInteger(result?.missioniCandidateFisiche), 'conteggio non valido');
  assert(result.missioniCandidateFisiche === result.candidati.length, 'conteggio candidati discordante');
  assert(result.candidati.every(c => c?.attivabile === false), 'candidato attivabile');
  const perOpportunita = opportunityIds.map(id => ({
    opportunitaId: id,
    candidatiFisici: result.candidati.filter(c => Number(c.pixelOpportunitaId) === id).length,
    partenzaMin: (() => { const a=result.candidati.filter(c=>Number(c.pixelOpportunitaId)===id); return a.length ? new Date(Math.min(...a.map(c=>c.departure))).toISOString() : null; })(),
    arrivoMax: (() => { const a=result.candidati.filter(c=>Number(c.pixelOpportunitaId)===id); return a.length ? new Date(Math.max(...a.map(c=>c.arrival))).toISOString() : null; })()
  }));

  assert(result.selezioneFisica?.shadow === true, 'selezione cicli non eseguita');
  assert(result.selezioneFisica?.attivabile === false, 'cicli attivabili');
  assert(result.selezioneFisica?.dbWrites === 0, 'scritture cicli');
  const summary = {
    stato: 'PASS_SHADOW_READ_ONLY',
    opportunita: opportunityIds,
    percorso: result.percorso,
    missioniCandidateFisiche: result.missioniCandidateFisiche,
    offerte: result.offerte,
    dbWrites: result.dbWrites,
    attivabile: result.attivabile,
    diagnostica: result.diagnostica,
    perOpportunita,
    diagnosticaCicli: result.selezioneFisica.diagnostica,
    migliorCiclo: result.selezioneFisica.migliorCiclo ? {
      vehicleId:result.selezioneFisica.migliorCiclo.vehicleId,
      richiestaIds:result.selezioneFisica.migliorCiclo.richiestaIds,
      economia:result.selezioneFisica.migliorCiclo.economia
    } : null
  };
  console.log('POPBUS_PHYSICAL_CYCLES_SHADOW_RESULT=' + JSON.stringify(summary, null, 2));
  if (result.candidati.length === 0) {
    console.log('ATTENZIONE: zero candidati. Il controllo di sicurezza passa, NON la fattibilita fisica.');
  } else {
    console.log('Candidati fisici non attivabili:', result.candidati.length);
  }
  if (perOpportunita.some(o => o.candidatiFisici === 0)) {
    console.log('DIAGNOSI: almeno una opportunita non ha alternative fisiche; non si puo certificare il test multimissione.');
  } else if (result.selezioneFisica.diagnostica.coppieTemporali === 0) {
    console.log('DIAGNOSI: entrambe le opportunita hanno candidati, ma nessuna coppia temporalmente concatenabile.');
  } else {
    console.log('DIAGNOSI: presenti coppie temporali; verificare scarti vincoli, routing ed economia.');
  }
  console.log('POPBUS_TWO_OPPORTUNITIES_SHADOW_DIAGNOSTIC_OK');
}

try {
  await main();
} catch (error) {
  console.error('POPBUS_PHYSICAL_SHADOW_READONLY_FAIL:', error?.stack ?? String(error));
  process.exitCode = 1;
} finally {
  await pool.end();
}
