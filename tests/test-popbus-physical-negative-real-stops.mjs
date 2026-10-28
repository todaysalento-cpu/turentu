// TURENTU — SHADOW negativo, opportunita PIXEL 118, solo fermate reali.
// Nessuna scrittura, nessuna fermata sintetica, nessuna attivazione.
import assert from 'node:assert/strict';
import { pool } from '../db/db.js';
import { processaPixelFirstMultimissione } from '../services/popbus/v2/pixel-first-multimission-service.js';
import { generaAlternativeFisichePixelShadow } from '../services/popbus/v2/popbus-pixel-stop-bridge.service.js';

const OPPORTUNITA = 118;
const RICHIESTE_AMMESSE = new Set([196, 197, 198, 199, 200, 201]);
const MOTIVI_COPERTURA = new Set([
  'RICHIESTA_SENZA_CANDIDATI',
  'FERMATE_COMPATIBILI_ASSENTI',
  'NESSUNA_COPPIA_FERMATE'
]);

async function main() {
  // Impedisce che il test passi con un catalogo artificiale o una ricerca campionata.
  for (const name of ['POPBUS_SHADOW_DIAGNOSTIC_STOPS', 'POPBUS_PHYSICAL_DIAGNOSTIC_LIMIT']) {
    if (process.env[name] != null) throw new Error(`Disattivare ${name} prima del test`);
  }
  const chiamate = [];
  const bridgeOsservato = async args => {
    assert.equal(Number(args.formazione.pixelOpportunitaId), OPPORTUNITA);
    const ids = args.formazione.evaluation.requests.map(r => Number(r.id));
    assert.ok(ids.length > 0, 'formazione senza richieste');
    assert.ok(ids.every(id => RICHIESTE_AMMESSE.has(id)),
      `formazione contiene richieste estranee: ${ids.join(',')}`);
    // Invoca il bridge REALE, senza sostituire query, fermate o routing.
    const risposta = await generaAlternativeFisichePixelShadow(args);
    chiamate.push({ids, ok:risposta.ok, motivo:risposta.motivo ?? null,
      alternative:risposta.alternativeFisiche?.length ?? null,
      diagnostica:risposta.diagnostica ?? null});
    return risposta;
  };

  const risultato = await processaPixelFirstMultimissione({
    pool, now:Date.now(), mode:'ROLLBACK_ONLY', physicalShadow:true,
    physicalOpportunityIds:[OPPORTUNITA], physicalShadowBridge:bridgeOsservato
  });
  console.log('\n[SHADOW RISULTATO]', JSON.stringify({
    percorso:risultato.percorso, missioniCandidateFisiche:risultato.missioniCandidateFisiche,
    diagnostica:risultato.diagnostica, chiamateBridge:chiamate
  }, null, 2));

  assert.equal(risultato.modalita, 'ROLLBACK_ONLY');
  assert.equal(risultato.percorso, 'PIXEL_FERMATE_FISICHE_CANDIDATI_V2');
  assert.equal(risultato.dbWrites, 0);
  assert.equal(risultato.offerte, 0);
  assert.equal(risultato.attivabile, false);
  assert.equal(risultato.missioniCandidateFisiche, 0,
    'trovate alternative fisiche: verificare copertura catalogo');
  assert.ok(chiamate.length > 0,
    'TEST NON CONCLUSIVO: nessuna formazione PIXEL ha raggiunto il bridge');
  for (const [i, call] of chiamate.entries()) {
    assert.equal(call.ok, false,
      `bridge #${i + 1}: risultato inatteso, verificare diagnostica`);
    assert.equal(call.alternative, 0);
    assert.ok(MOTIVI_COPERTURA.has(call.motivo),
      `bridge #${i + 1}: scarto non attribuibile alla copertura: ${call.motivo}`);
  }
  // Per scarti precoci (assenza di fermate/coppie) la ricerca combinatoria
  // non parte: ricercaEsaustiva puo essere assente, senza budget esaurito.
  assert.equal(risultato.diagnostica?.completo, true,
    'diagnostica multimissione incompleta: risultato non certificabile');
  console.log(`\nPASS: ${chiamate.length} valutazioni reali, nessuna alternativa, scarti di copertura, nessuna scrittura.`);
}

main().catch(error => {
  console.error('\nFAIL SHADOW:', error.stack ?? error);
  process.exitCode = 1;
}).finally(async () => {
  await pool.end();
});
