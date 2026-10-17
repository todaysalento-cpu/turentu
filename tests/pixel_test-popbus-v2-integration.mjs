// Copiare in tests/pixel_test-popbus-v2-integration.mjs
// Non usa DB, non assegna veicoli e non genera corse.
import assert from 'node:assert/strict';
import { diagnosticaPixelPopbusV2 } from '../services/pixel/pixel-popbus-v2-adapter.js';

const leg = { metres: 28000, seconds: 1800, polyline: 'abc' };
const richiesta = { id: 1001, start_node_id: 6, end_node_id: 5,
  start_datetime: '2027-04-01T09:00:00.000Z', posti_richiesti: 2, prezzo: 30 };
const engine = {
  getCorridor: id => id === 'px-test' ? { nodes: [6, 5], legs: [leg] } : null,
  getRequest: id => id === 1001 ? richiesta : null,
  temporalCandidatesCompleteWithReturns: async () => [{
    richiestaIds: [1001], finestreRitornoPerNodo: { 5: [] }
  }]
};
const run = input => diagnosticaPixelPopbusV2({ engine, direttriceId: 'px-test', richieste: input });
const ok = await run([richiesta]);
assert.equal(ok.length, 1);
assert.equal(ok[0].compatibilePopbus, true);
assert.equal(ok[0].evaluation.peak, 2);
assert.equal(ok[0].attivabile, false);
console.log('OK 1: PIXEL -> POPBUS valuta richiesta con qualità e occupazione');
console.log('OK 2: nessuna attivazione senza verifica veicolo, economia e ritorno base');
const noPrice = await run([{ ...richiesta, prezzo: undefined }]);
assert.equal(noPrice[0].motivo, 'PREZZI_MANCANTI');
console.log('OK 3: prezzi mancanti rifiutati senza inventare ricavi');
const missing = await run([]);
assert.equal(missing[0].motivo, 'RICHIESTE_MANCANTI');
console.log('OK 4: richieste non disponibili rilevate');
const wrong = await run([{ ...richiesta, end_node_id: 7 }]);
assert.equal(wrong[0].motivo, 'NODI_RICHIESTA_INCOERENTI');
console.log('OK 5: mapping nodi incoerente rifiutato');
console.log('PIXEL POPBUS V2 DIAGNOSTICA: 5 test superati; nessuna scrittura DB');
