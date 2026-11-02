// TURENTU POPBUS V2 — FASE 5A, test offline. Nessuna connessione DB.
// Copiare in tests/test-popbus-ar-preflight-fase5a.js
import assert from 'node:assert/strict';
import { preflightTransazionaleAR } from '../services/popbus/v2/popbus-ar-transaction-preflight.service.js';

const G = '11111111-1111-4111-8111-111111111111';
const FUTURO = new Date(Date.now() + 3_600_000).toISOString();
const PASSATO = new Date(Date.now() - 3_600_000).toISOString();

function mockClient({ missingReturn = false, expired = false, mutateClosure = false } = {}) {
  const calls = [];
  let graphReads = 0;
  const activations = [101, 102];
  const client = {
    calls,
    async query(sql, params = []) {
      const q = sql.replace(/\s+/g, ' ').trim();
      calls.push({ q, params });
      if (q.includes('pg_advisory_xact_lock')) return { rows: [{ pg_advisory_xact_lock: null }] };
      if (q.includes('FROM popbus_attivazioni a') && q.includes('LEFT JOIN popbus_ar_accettazioni p')) {
        const id = Number(params[0]);
        if (!activations.includes(id)) return { rows: [] };
        return { rows: [{
          id, stato: 'in_attesa_autista', expires_at: FUTURO, veicolo_id: id,
          accettazione_id: id + 1000, accettazione_stato: 'provvisoria',
          accettazione_scadenza: expired && id === 102 ? PASSATO : FUTURO,
          offerta_id: id + 2000, offerta_stato: 'inviata', offerta_scadenza: FUTURO
        }] };
      }
      if (q.includes('FROM popbus_attivazione_richieste ar') && q.includes('JOIN richieste_pop_bus r')) {
        const id = Number(params[0]);
        if (!activations.includes(id)) return { rows: [] };
        return { rows: [{ richiesta_id: id === 101 ? 1 : 2, cliente_id: 10, ar_group_id: G,
          ar_tratta: id === 101 ? 'andata' : 'ritorno', ar_vincolata: true,
          richiesta_stato: 'in_lavorazione', corsa_id: null }] };
      }
      if (q.includes('SELECT DISTINCT ar.attivazione_id')) {
        graphReads++;
        return { rows: (mutateClosure && graphReads > 2 ? [101] : activations).map(attivazione_id => ({ attivazione_id })) };
      }
      if (q.includes('FROM ar_gruppi g') && q.includes('LEFT JOIN richieste_pop_bus r')) {
        const reqs = [{ richiesta_id: 1, richiesta_cliente_id: 10, ar_tratta: 'andata', attivazione_id: 101 },
          ...(!missingReturn ? [{ richiesta_id: 2, richiesta_cliente_id: 10, ar_tratta: 'ritorno', attivazione_id: 102 }] : [])];
        return { rows: reqs.map(r => ({ gruppo_id: G, gruppo_cliente_id: 10, gruppo_stato: 'in_attesa',
          gruppo_scadenza: FUTURO, ar_vincolata: true, richiesta_stato: 'in_lavorazione', corsa_id: null, ...r })) };
      }
      if (q.startsWith('SELECT id FROM popbus_attivazioni') && q.includes('FOR UPDATE')) {
        return { rows: params[0].map(id => ({ id })) };
      }
      if (q.includes('FOR UPDATE')) return { rows: [] };
      throw new Error(`Query simulata non prevista: ${q}`);
    }
  };
  return client;
}

async function run(name, opts, expected) {
  const db = mockClient(opts);
  const result = await preflightTransazionaleAR(db, 101);
  assert.equal(result.stato, expected);
  assert.equal(result.confermaAbilitata, false);
  assert.deepEqual(result.attivazioniBloccate, [101, 102]);
  const sql = db.calls.map(c => c.q);
  assert.match(sql[0], /pg_advisory_xact_lock/);
  const lockIndex = sql.findIndex(s => s.includes('FROM popbus_attivazioni') && s.includes('FOR UPDATE'));
  assert.ok(lockIndex > 0, 'Manca lock attivazioni');
  for (const table of ['richieste_pop_bus', 'ar_gruppi', 'popbus_ar_accettazioni', 'offerte_autisti']) {
    assert.ok(sql.some(s => s.includes(table) && s.includes('FOR UPDATE')), `Manca lock ${table}`);
  }
  assert.equal(sql.some(s => /^(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|COMMIT|ROLLBACK|CREATE|ALTER|DROP)\b/i.test(s)), false, 'Query di scrittura rilevata');
  console.log(`OK: ${name} | ${result.stato} | ${sql.length} query simulate`);
}

await run('Coppia completa e valida', {}, 'pronta');
await run('Accettazione scaduta', { expired: true }, 'non_valida');
await run('Gruppo incompleto', { missingReturn: true }, 'non_valida');
const db = mockClient();
const missing = await preflightTransazionaleAR(db, 999);
assert.equal(missing.stato, 'non_valida');
assert.equal(missing.confermaAbilitata, false);
console.log('OK: Attivazione inesistente | non_valida');
console.log('TEST FASE 5A SUPERATI — solo simulazioni, nessun database.');
