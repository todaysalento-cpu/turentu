import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

const target = process.argv[2] || path.join('routes', 'stripe-webhook.js');
const source = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
function extract(start, end) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a + start.length);
  if (a < 0 || b < 0) throw Error(`Struttura webhook non riconosciuta: ${start}`);
  return source.slice(a, b);
}
const code = [
  extract('async function aggiornaStato(', '// =====================================================\n// PAGAMENTO COMPLETATO'),
  extract('async function handlePaymentSuccess(', '// =====================================================\n// PAGAMENTO FALLITO'),
  extract('async function handlePaymentFailed(', 'export { router };')
].join('\n');
function harness({ stato = 'pendente', importo = 10, corsa_id = null, tipo = 'prenota', pending = null } = {}) {
  const row = { id: 1, stato, importo, currency: 'eur', corsa_id };
  const calls = { writes: 0, created: 0, pendingUpdates: 0, emitted: 0, capture: 0 };
  const client = {
    async query(sql, params) {
      if (/^SELECT p\.id/i.test(sql.trim())) return { rowCount: 1, rows: [{ ...row }] };
      if (/^UPDATE public\.pagamenti/i.test(sql.trim())) {
        row.stato = params[0]; calls.writes++;
        return { rowCount: 1, rows: [] };
      }
      if (/FROM public\.veicolo/i.test(sql)) return { rowCount: 1, rows: [{ id: 2 }] };
      throw Error(`Query inattesa: ${sql.slice(0, 80)}`);
    }
  };
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    pendingService: {
      async getPendingById() { return pending; },
      async updatePendingStatus() { calls.pendingUpdates++; }
    },
    async createCorsaFromPending() { calls.created++; return { corsa: { id: 55 }, prenotazione: { id: 56 } }; },
    getIO() { return { to() { return { emit() { calls.emitted++; } }; } }; }
  });
  vm.runInContext(code + '\nthis.api = { aggiornaStato, handlePaymentSuccess, handlePaymentFailed };', context);
  const intent = (overrides = {}) => ({ id: 'pi_mock', status: 'succeeded', currency: 'eur', amount_received: 1000, ...overrides });
  return { ...context.api, client, row, calls, intent, tipo };
}

test('autorizzazione duplicata non riscrive il pagamento', async () => {
  const h = harness();
  assert.equal(await h.aggiornaStato('pi_mock', 'autorizzazione', h.client, h.intent({ status: 'requires_capture' })), true);
  assert.equal(await h.aggiornaStato('pi_mock', 'autorizzazione', h.client, h.intent({ status: 'requires_capture' })), false);
  assert.equal(h.calls.writes, 1);
});
test('NCC succeeded non cattura e non anticipa la riconciliazione', async () => {
  const h = harness({ stato: 'autorizzazione', corsa_id: 42 });
  await h.handlePaymentSuccess({ intent: h.intent({ amount_received: 725 }), tipo: 'prenota', corsaId: 42, roomId: 42, client: h.client, notifiche: [] });
  assert.equal(h.row.stato, 'autorizzazione');
  assert.equal(h.calls.writes, 0);
  assert.equal(h.calls.created, 0);
  assert.equal(h.calls.emitted, 0);
  assert.equal(source.includes('paymentIntents.capture'), false);
});
test('importo non NCC errato non conferma il pagamento', async () => {
  const h = harness();
  await assert.rejects(() => h.handlePaymentSuccess({ intent: h.intent({ amount_received: 999 }), tipo: 'prenota', client: h.client, notifiche: [] }), /non coerente/);
  assert.equal(h.row.stato, 'pendente');
});
test('evento fallito dopo pagato non retrocede lo stato', async () => {
  const h = harness({ stato: 'pagato' });
  await h.handlePaymentFailed({ intent: h.intent({ status: 'requires_payment_method' }), stato: 'fallito', roomId: 5, client: h.client, notifiche: [] });
  assert.equal(h.row.stato, 'pagato');
  assert.equal(h.calls.writes, 0);
});
test('richiedi duplicato crea una sola corsa', async () => {
  const h = harness({ pending: { id: 12, veicolo_id: 2 } });
  const args = { intent: h.intent(), tipo: 'richiedi', pendingId: 12, roomId: 12, client: h.client, notifiche: [] };
  await h.handlePaymentSuccess(args);
  await h.handlePaymentSuccess(args);
  assert.equal(h.row.stato, 'pagato');
  assert.equal(h.calls.created, 1);
  assert.equal(h.calls.pendingUpdates, 1);
});
test('pagato non viene riportato ad autorizzazione', async () => {
  const h = harness({ stato: 'pagato' });
  assert.equal(await h.aggiornaStato('pi_mock', 'autorizzazione', h.client, h.intent({ status: 'requires_capture' })), false);
  assert.equal(h.row.stato, 'pagato');
});
test('richiedi con pending mancante segnala errore (rollback necessario nel router)', async () => {
  const h = harness({ pending: null });
  await assert.rejects(() => h.handlePaymentSuccess({ intent: h.intent(), tipo: 'richiedi', pendingId: 12, roomId: 12, client: h.client, notifiche: [] }), /non trovato/);
  assert.equal(h.row.stato, 'pagato'); // Il mock non ha transazioni: il router deve eseguire ROLLBACK.
});
