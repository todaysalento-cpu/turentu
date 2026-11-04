
// TURENTU — SHADOW positivo, opportunità PIXEL 322.
// Fermate reali provvisorie: nessuna scrittura o attivazione.

import assert from 'node:assert/strict';
import { pool } from '../db/db.js';
import { processaPixelFirstMultimissione } from '../services/popbus/v2/pixel-first-multimission-service.js';
import { generaAlternativeFisichePixelShadow } from '../services/popbus/v2/popbus-pixel-stop-bridge.service.js';
import { cercaFermateCandidate } from '../services/popbus/v2/popbus-stop-candidates.service.js';

const OPPORTUNITA = 322;
const RICHIESTE = [562, 563, 564, 565, 566, 567];
const FERMATE_PROVVISORIE = [14, 15, 16, 17];

async function main() {
  for (const name of [
    'POPBUS_SHADOW_DIAGNOSTIC_STOPS',
    'POPBUS_PHYSICAL_DIAGNOSTIC_LIMIT'
  ]) {
    if (process.env[name] != null) {
      throw new Error(`Disattivare ${name} prima del test`);
    }
  }

  // 1. Verifica reale del catalogo delle fermate.
  const catalogo = await cercaFermateCandidate({
    client: pool,
    richiestaIds: RICHIESTE,
    raggioMetri: 1500,
    limite: 5
  });

  const fermateTrovate = new Map();

  for (const richiesta of catalogo) {
    for (const fermata of [
      ...richiesta.salita,
      ...richiesta.discesa
    ]) {
      fermateTrovate.set(fermata.fermata_id, fermata);
    }
  }

  for (const id of FERMATE_PROVVISORIE) {
    const fermata = fermateTrovate.get(id);

    assert.ok(fermata, `FERMATA ${id} non selezionata`);
    assert.equal(
      fermata.verificata,
      false,
      `FERMATA ${id}: il test deve utilizzare una fermata provvisoria`
    );

    console.log(`PASS FERMATA ${id}: selezionata, verificata=false`);
  }

  // 2. Invocazione del bridge fisico reale.
  const chiamate = [];

  const bridgeOsservato = async args => {
    assert.equal(
      Number(args.formazione.pixelOpportunitaId),
      OPPORTUNITA
    );

    const ids = args.formazione.evaluation.requests.map(
      r => Number(r.id)
    );

    assert.ok(ids.length > 0);
    assert.ok(ids.every(id => RICHIESTE.includes(id)));

    const risposta = await generaAlternativeFisichePixelShadow(args);

    chiamate.push({
      richieste: ids,
      ok: risposta.ok,
      motivo: risposta.motivo ?? null,
      alternative: risposta.alternativeFisiche?.length ?? 0,
      diagnostica: risposta.diagnostica ?? null
    });

    return risposta;
  };

  const risultato = await processaPixelFirstMultimissione({
    pool,
    now: Date.now(),
    mode: 'ROLLBACK_ONLY',
    physicalShadow: true,
    physicalOpportunityIds: [OPPORTUNITA],
    physicalShadowBridge: bridgeOsservato
  });

  console.log('\n[SHADOW RISULTATO]');
  console.log(JSON.stringify({
    percorso: risultato.percorso,
    missioniCandidateFisiche: risultato.missioniCandidateFisiche,
    diagnostica: risultato.diagnostica,
    chiamateBridge: chiamate
  }, null, 2));

  // 3. Verifica del percorso e della sicurezza.
  assert.equal(risultato.modalita, 'ROLLBACK_ONLY');
  assert.equal(
    risultato.percorso,
    'PIXEL_FERMATE_FISICHE_CANDIDATI_V2'
  );
  assert.equal(risultato.dbWrites, 0);
  assert.equal(risultato.offerte, 0);
  assert.equal(risultato.attivabile, false);

  assert.ok(
    chiamate.length > 0,
    'NESSUNA FORMAZIONE HA RAGGIUNTO IL BRIDGE'
  );

  assert.equal(
    risultato.diagnostica?.completo,
    true,
    'Diagnostica fisica incompleta'
  );

  console.log('\nPASS: fermate provvisorie ammesse nel catalogo.');
  console.log(`PASS: ${chiamate.length} valutazioni bridge reali.`);
  console.log('PASS: nessuna scrittura, offerta o attivazione.');
}

main()
  .catch(error => {
    console.error('\nFAIL SHADOW:', error.stack ?? error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
