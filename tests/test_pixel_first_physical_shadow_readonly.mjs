// TURENTU POPBUS V2 — Acceptance diagnostica fermate fisiche, sola lettura.
// Installare come tests/test_pixel_first_physical_shadow_readonly.mjs
// Avviare: node --env-file=.env tests/test_pixel_first_physical_shadow_readonly.mjs
// Opzionale: set POPBUS_SHADOW_OPPORTUNITY_ID=118
// NON abilita LIVE, NON esegue persistenza, NON certifica l'economia del ciclo.

import { pool } from '../db/db.js';
import { processaPixelFirstMultimissione } from '../services/popbus/v2/pixel-first-multimission-service.js';

const assert = (ok, message) => { if (!ok) throw new Error(`SHADOW_PHYSICAL_ASSERT: ${message}`); };
const positive = x => x != null && x !== '' && Number.isSafeInteger(Number(x)) && Number(x) > 0;

async function main() {
  assert(process.env.POPBUS_PIXEL_FIRST_LIVE_APPROVED !== '1', 'LIVE_APPROVED attivo');
  assert(process.env.POPBUS_PIXEL_FIRST_ENABLED !== 'true', 'scheduler PIXEL-first attivo');
  const raw = process.env.POPBUS_SHADOW_OPPORTUNITY_ID;
  const opportunityIds = raw == null || raw === '' ? [118] : [Number(raw)];
  assert(opportunityIds.every(positive), 'ID opportunita non valido');

  // Il servizio apre internamente una transazione REPEATABLE READ READ ONLY.
  // Qui usiamo una query di sola lettura anche per la verifica del database.
  const db = await pool.query('SELECT current_database() AS name, pg_is_in_recovery() AS replica');
  assert(db.rows[0]?.name === 'corse_db', 'database diverso da corse_db');

  const result = await processaPixelFirstMultimissione({
    pool,
    mode: 'ROLLBACK_ONLY',
    physicalShadow: true,
    physicalOpportunityIds: opportunityIds
  });

  assert(result?.modalita === 'ROLLBACK_ONLY', 'modalita errata');
  assert(result?.percorso === 'PIXEL_FERMATE_FISICHE_CANDIDATI_V2', 'percorso fisico non eseguito');
  assert(result?.offerte === 0, 'offerte non nulle');
  assert(result?.dbWrites === 0, 'dbWrites non nullo');
  assert(result?.attivabile === false, 'risultato attivabile');
  assert(Array.isArray(result?.candidati), 'candidati mancanti');
  assert(Number.isSafeInteger(result?.missioniCandidateFisiche), 'conteggio non valido');
  assert(result.missioniCandidateFisiche === result.candidati.length, 'conteggio candidati discordante');
  assert(result.candidati.every(c => c?.attivabile === false), 'candidato attivabile');

  const summary = {
    stato: 'PASS_SHADOW_READ_ONLY',
    opportunita: opportunityIds,
    percorso: result.percorso,
    missioniCandidateFisiche: result.missioniCandidateFisiche,
    offerte: result.offerte,
    dbWrites: result.dbWrites,
    attivabile: result.attivabile,
    diagnostica: result.diagnostica
  };
  console.log('POPBUS_PHYSICAL_SHADOW_RESULT=' + JSON.stringify(summary, null, 2));
  if (result.candidati.length === 0) {
    console.log('ATTENZIONE: zero candidati. Il controllo di sicurezza passa, NON la fattibilita fisica.');
  } else {
    console.log('Candidati fisici non attivabili:', result.candidati.length);
  }
  console.log('POPBUS_PHYSICAL_SHADOW_READONLY_OK');
}

try {
  await main();
} catch (error) {
  console.error('POPBUS_PHYSICAL_SHADOW_READONLY_FAIL:', error?.stack ?? String(error));
  process.exitCode = 1;
} finally {
  await pool.end();
}
