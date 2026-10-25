// tests/test_pixel_provisional_admission.js
// Test unitario con database simulato: NON apre connessioni PostgreSQL reali.
import assert from 'node:assert/strict';
import { admitPixelStopProvisionally } from '../services/pixel/pixel-stop-provisional-admission.service.js';

function mockDatabase(stop, { queryError = null } = {}) {
  const statements = [];
  let released = false;
  const client = {
    async query(sql, params = []) {
      const statement = String(sql).trim();
      statements.push({ sql: statement, params });
      if (queryError && statement.startsWith('SELECT')) throw queryError;
      if (statement.startsWith('SELECT')) return { rows: stop ? [stop] : [] };
      return { rows: [] };
    },
    release() { released = true; }
  };
  return {
    database: { async connect() { return client; } },
    statements,
    get released() { return released; }
  };
}

const base = {
  id: 101,
  nome: 'Fermata ordinaria',
  attiva: false,
  verificata: false,
  nodo_attivo: true,
  fermata_test: false,
  evidenza_negativa: false
};
let passed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`OK ${++passed}: ${name}`); }
  catch (err) { console.error(`FAIL: ${name}\n${err.stack}`); process.exitCode = 1; }
}
function sqlTypes(mock) {
  return mock.statements.map(x => x.sql.split(/\s+/)[0].toUpperCase());
}

await test('dryRun predefinito: ammissibile, non certificata, nessun UPDATE', async () => {
  const m = mockDatabase({ ...base });
  const result = await admitPixelStopProvisionally({ fermata_id: 101 }, { database: m.database });
  assert.deepEqual(result, { fermata_id: '101', ammissibile: true, simulazione: true, gia_attiva: false });
  assert.deepEqual(sqlTypes(m), ['BEGIN', 'SELECT', 'ROLLBACK']);
  assert.equal(m.released, true);
});

await test('dryRun con fermata gia attiva: nessun UPDATE', async () => {
  const m = mockDatabase({ ...base, attiva: true });
  const result = await admitPixelStopProvisionally({ fermata_id: '101' }, { database: m.database, dryRun: true });
  assert.equal(result.gia_attiva, true);
  assert.deepEqual(sqlTypes(m), ['BEGIN', 'SELECT', 'ROLLBACK']);
  assert.equal(m.released, true);
});

for (const [name, stop, message] of [
  ['fermata inesistente', null, 'PIXEL: fermata inesistente'],
  ['nodo inattivo', { ...base, nodo_attivo: false }, 'PIXEL: nodo territoriale inattivo'],
  ['fixture metadata', { ...base, fermata_test: true }, 'PIXEL: fermata di test esclusa'],
  ['nome TEST PIXEL', { ...base, nome: 'TEST PIXEL - Tiggiano' }, 'PIXEL: fermata di test esclusa'],
  ['nome [TEST PIXEL]', { ...base, nome: '[TEST PIXEL] Nodo 4' }, 'PIXEL: fermata di test esclusa'],
  ['evidenza negativa', { ...base, evidenza_negativa: true }, 'PIXEL: evidenza negativa presente']
]) {
  await test(`${name}: rifiuto e rollback`, async () => {
    const m = mockDatabase(stop);
    await assert.rejects(
      admitPixelStopProvisionally({ fermata_id: 101 }, { database: m.database, dryRun: false }),
      { message }
    );
    assert.deepEqual(sqlTypes(m), ['BEGIN', 'SELECT', 'ROLLBACK']);
    assert.equal(m.released, true);
  });
}

await test('ID non valido: nessuna connessione', async () => {
  let connected = false;
  const database = { async connect() { connected = true; throw new Error('Non deve connettersi'); } };
  await assert.rejects(admitPixelStopProvisionally({ fermata_id: 'abc' }, { database }),
    { message: 'PIXEL: fermata_id non valido' });
  assert.equal(connected, false);
});

await test('percorso dryRun=false: UPDATE e COMMIT soltanto sul mock', async () => {
  const m = mockDatabase({ ...base });
  const result = await admitPixelStopProvisionally({ fermata_id: 101 }, { database: m.database, dryRun: false });
  assert.deepEqual(result, { fermata_id: '101', attiva: true, verificata: false, modalita: 'PROVISIONAL' });
  assert.deepEqual(sqlTypes(m), ['BEGIN', 'SELECT', 'UPDATE', 'COMMIT']);
  assert.match(m.statements[2].sql, /SET\s+attiva\s*=\s*TRUE/i);
  assert.doesNotMatch(m.statements[2].sql, /verificata\s*=/i);
  assert.deepEqual(m.statements[2].params, ['101']);
  assert.equal(m.released, true);
});

await test('errore query: rollback e rilascio connessione', async () => {
  const m = mockDatabase({ ...base }, { queryError: new Error('Errore simulato SELECT') });
  await assert.rejects(admitPixelStopProvisionally({ fermata_id: 101 }, { database: m.database }),
    { message: 'Errore simulato SELECT' });
  assert.deepEqual(sqlTypes(m), ['BEGIN', 'SELECT', 'ROLLBACK']);
  assert.equal(m.released, true);
});

if (process.exitCode) console.error(`FAIL: alcuni test non sono passati (${passed} superati).`);
else console.log(`PASS: ${passed} verifiche. Database interamente simulato; nessuna scrittura reale.`);
