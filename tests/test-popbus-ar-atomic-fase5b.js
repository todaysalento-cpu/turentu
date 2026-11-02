// TURENTU POPBUS V2 - FASE 5B: TEST OFFLINE DELL'ORCHESTRAZIONE
// Salvare come tests/test-popbus-ar-atomic-fase5b.js
// Richiede services/popbus/v2/popbus-ar-atomic-orchestrator-fase5b.js
import assert from 'node:assert/strict';
import { simulaFinalizzazioneAR } from '../services/popbus/v2/popbus-ar-atomic-orchestrator-fase5b.js';

function fakeDb() {
  const log = [];
  return {
    log,
    client: { async query(sql) { log.push(sql); return { rows: [] }; } }
  };
}

async function scenario(nome, opts) {
  const db = fakeDb();
  const events = [];
  const preflight = async () => ({
    stato: opts.stato ?? 'pronta',
    anomalie: [],
    attivazioniBloccate: [101, 102]
  });
  let n = 0;
  const converti = async (_client, id) => {
    n++;
    events.push(`converti:${id}`);
    if (opts.fallisceAlla === n) throw new Error('Errore conversione simulato');
    return { id: 900 + n, attivazioneId: id };
  };
  const pubblicaDopoCommit = async () => {
    assert.equal(db.log.at(-1), 'COMMIT');
    events.push('pubblica');
  };
  let error = null;
  try {
    await simulaFinalizzazioneAR({ client: db.client, attivazioneId: 101,
      preflight, converti, pubblicaDopoCommit });
  } catch (e) { error = e; }
  if (opts.errore) {
    assert.ok(error, `${nome}: errore atteso`);
    assert.equal(db.log[0], 'BEGIN');
    assert.equal(db.log.at(-1), 'ROLLBACK');
    assert.ok(!db.log.includes('COMMIT'));
    assert.ok(!events.includes('pubblica'));
  } else {
    assert.equal(error, null, `${nome}: ${error?.message}`);
    assert.deepEqual(db.log, ['BEGIN', 'COMMIT']);
    assert.deepEqual(events, ['converti:101', 'converti:102', 'pubblica']);
  }
  console.log(`OK: ${nome} | ${db.log.join(' -> ')}`);
}

await scenario('Due conversioni riuscite', {});
await scenario('Seconda conversione fallita', { fallisceAlla: 2, errore: true });
await scenario('Prima conversione fallita', { fallisceAlla: 1, errore: true });
await scenario('Preflight non pronto', { stato: 'in_attesa', errore: true });
console.log('TEST FASE 5B SUPERATI - SOLO MOCK, NESSUN DATABASE.');
