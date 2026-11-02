import assert from 'node:assert/strict';
import { verificaIdentitaOfferteAR } from '../services/popbus/v2/popbus-ar-fase5e-identity-guard.js';

const future = new Date(Date.now() + 3600000).toISOString();
const base = {
  attivazione_id: 101, operatore_id: 9, veicolo_id: 7,
  attivazione_stato: 'in_attesa_autista', attivazione_scadenza: future,
  corsa_id: null, accettazione_id: 1, offerta_id: 201,
  accettazione_veicolo_id: 7, accettazione_stato: 'provvisoria',
  accettazione_scadenza: future, offerta_operatore_id: 9,
  offerta_attivazione_id: 101, offerta_stato: 'inviata', offerta_scadenza: future
};
const analysis = { stato: 'pronta', attivazioni: [101], gruppi: [{id: 'g'}],
  anomalie: [], confermaAbilitata: false };
async function test(label, rows, expectedError = false) {
  const queries = [];
  const client = { async query(sql, params) {
    queries.push(sql);
    assert.deepEqual(params, [[101]]);
    return { rows };
  }};
  if (expectedError) {
    await assert.rejects(() => verificaIdentitaOfferteAR(client, analysis),
      e => e.code === 'AR_IDENTITY_INVALID');
  } else {
    const result = await verificaIdentitaOfferteAR(client, analysis);
    assert.deepEqual(result.map(x => x.offertaId), [201]);
  }
  assert.equal(queries.length, 1);
  assert.match(queries[0], /FOR UPDATE OF a, p, o/);
  assert.doesNotMatch(queries[0], /\b(?:INSERT|DELETE|UPDATE)\s+(?:INTO|FROM|[a-z_]+\s+SET)\b/i);
  console.log('OK:', label);
}
await test('Identita coerente', [{...base}]);
await test('Operatore incoerente', [{...base, offerta_operatore_id: 99}], true);
await test('Offerta di altra attivazione', [{...base, offerta_attivazione_id: 102}], true);
await test('Veicolo incoerente', [{...base, accettazione_veicolo_id: 8}], true);
await test('Offerta scaduta', [{...base, offerta_scadenza: new Date(Date.now()-1000)}], true);
await test('Corsa gia creata', [{...base, corsa_id: 555}], true);
await test('Accettazione mancante', [], true);
console.log('FASE 5E: 7/7 TEST OFFLINE SUPERATI. NESSUN DATABASE.');
