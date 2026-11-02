// TURENTU - Test isolato END, Node.js 22
// Copiare in tests/test_corse_conducenti_end.js
// Eseguire: node tests/test_corse_conducenti_end.js
// Nessuna connessione PostgreSQL, Redis o Stripe reale.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const servicePath = path.resolve(here, '../services/corsa/corse.service.js');
const source = await readFile(servicePath, 'utf8');
const required = [
  'export async function toggleCorsa(corsa_id, action, utenteId)',
  'FOR UPDATE OF ac',
  'stripe.paymentIntents.capture(',
  "SET stato = 'completata'",
];
for (const fragment of required) {
  assert.ok(source.includes(fragment), `Servizio differente: manca ${fragment}`);
}

let active;
const log = [];
const stripe = {
  paymentIntents: {
    async retrieve(id) {
      log.push('STRIPE_RETRIEVE');
      if (active.piError) throw new Error('Stripe retrieve simulato fallito');
      return { id, currency: 'eur', amount: 1000, amount_capturable: 1000,
        status: active.piStatus ?? 'requires_capture',
        amount_received: active.piStatus === 'succeeded' ? 1000 : 0 };
    },
    async capture(id, params, opts) {
      log.push('STRIPE_CAPTURE');
      assert.equal(id, 'pi_mock');
      assert.equal(params.amount_to_capture, 1000);
      assert.match(opts.idempotencyKey, /turentu-corsa-923-pagamento-701-capture-v1/);
      if (active.captureError) throw new Error('Cattura simulata fallita');
      return { id, status: 'succeeded', amount_received: 1000 };
    },
  },
};
const pool = {
  async connect() {
    log.push('CONNECT');
    return {
      release() { log.push('RELEASE'); },
      async query(sql, params = []) {
        const q = String(sql).replace(/\s+/g, ' ').trim();
        if (q === 'BEGIN') { log.push('BEGIN'); return { rows: [], rowCount: null }; }
        if (q === 'COMMIT') { log.push('COMMIT'); return { rows: [], rowCount: null }; }
        if (q === 'ROLLBACK') { log.push('ROLLBACK'); return { rows: [], rowCount: null }; }
        if (q.startsWith('UPDATE public.corse')) {
          log.push('UPDATE_CORSA');
          assert.deepEqual(params, ['completata', 923, 'in_corso']);
          return { rows: [{ id: 923, stato: 'completata', veicolo_id: 364,
            tipo_corsa: 'privata', prezzo_fisso: 10, prenotazione_origine_id: 801,
            km_totali_percorso: 10 }], rowCount: 1 };
        }
        if (q.includes('FROM public.assegnazioni_conducenti ac')) {
          log.push('CHECK_CONDUCENTE');
          assert.deepEqual(params, [923, active.userId, 364]);
          return { rows: active.authorized ? [{ id: 901 }] : [],
            rowCount: active.authorized ? 1 : 0 };
        }
        if (q.includes('FROM public.pagamenti p JOIN public.prenotazioni pr')) {
          log.push('PAGAMENTI');
          return { rows: [{ pagamento_id: 701, stripe_payment_intent: 'pi_mock',
            prenotazione_id: 801, importo_db: 10, stato_pagamento: 'autorizzazione',
            posti_richiesti: 1, cliente_id: 3, start_offset: 0, end_offset: 10000,
            km_utente: 10, prezzo_totale: 10 }] };
        }
        if (q.includes('FROM public.prenotazioni') && q.includes('posti_richiesti')) {
          log.push('PRENOTAZIONI');
          return { rows: [{ id: 801, posti_richiesti: 1, km_utente: 10,
            start_offset: 0, end_offset: 10000 }] };
        }
        if (q.includes('FROM public.prenotazioni pr LEFT JOIN public.pagamenti p')) {
          log.push('COPERTURA');
          return { rows: [{ prenotazione_id: 801, prezzo_totale: 10,
            pagamento_id: active.missingPayment ? null : 701,
            stato_pagamento: 'autorizzazione', stripe_payment_intent: 'pi_mock',
            importo_pagato: 10 }] };
        }
        if (q.includes('FROM public.pagamenti p LEFT JOIN public.prenotazioni pr')) {
          log.push('ORFANI');
          return { rows: [] };
        }
        if (q.includes('SELECT id, prezzo_totale') && q.includes('FROM public.prenotazioni')) {
          log.push('QUOTE');
          return { rows: [{ id: 801, prezzo_totale: 10 }] };
        }
        if (q.startsWith('UPDATE public.pagamenti')) {
          log.push('UPDATE_PAGAMENTO');
          if (active.failAfterCapture) throw new Error('DB update pagamento simulato fallito');
          return { rowCount: 1, rows: [] };
        }
        if (q.startsWith('UPDATE public.assegnazioni_conducenti')) {
          log.push('COMPLETA_ASSEGNAZIONE');
          if (active.failAssignment) return { rowCount: 0, rows: [] };
          return { rowCount: 1, rows: [{ id: 901 }] };
        }
        throw new Error(`Query non simulata: ${q.slice(0, 160)}`);
      },
    };
  },
};

// Carica il codice REALE del servizio con sole dipendenze sostituite in memoria.
// Non viene importato il modulo originale (che inizializzerebbe Stripe e Redis).
const transformed = source
  .replace(/^import\s+.*?;\s*$/gm, '')
  .replace(/const stripe = new Stripe\(process\.env\.STRIPE_SECRET_KEY\);/, 'const stripe = globalThis.__turentuEndMocks.stripe;')
  .replace(/\/\* ===================== HELPERS ===================== \*\//,
    `const { pool, CacheManager, removeCorsa, calcolaPrezzo, getTariffe } = globalThis.__turentuEndMocks;\n/* ===================== HELPERS ===================== */`);
assert.ok(!/^import\s/m.test(transformed), 'Import non sostituito');
globalThis.__turentuEndMocks = {
  pool, stripe, CacheManager: { corsa: { update() { log.push('CACHE_UPDATE'); } } },
  async removeCorsa() { log.push('REMOVE_CACHE'); },
  async calcolaPrezzo() { throw new Error('Pricing legacy non previsto in questo test'); },
  async getTariffe() { throw new Error('Tariffe non previste in questo test'); },
};
const url = `data:text/javascript;base64,${Buffer.from(transformed).toString('base64')}`;
const { toggleCorsa } = await import(url);

async function scenario(name, config, expected) {
  active = { userId: 2, authorized: true, ...config };
  log.length = 0;
  let error;
  let result;
  try { result = await toggleCorsa(923, 'end', active.userId); }
  catch (e) { error = e; }
  if (expected.error) {
    assert.ok(error, `${name}: errore atteso`);
    if (expected.status) assert.equal(error.status, expected.status);
    if (expected.message) assert.match(error.message, expected.message);
    assert.ok(log.includes('ROLLBACK'), `${name}: manca ROLLBACK`);
    assert.ok(!log.includes('COMMIT'), `${name}: COMMIT non previsto`);
  } else {
    if (error) throw error;
    assert.equal(result.stato, 'completata');
    assert.ok(log.includes('COMMIT'), `${name}: manca COMMIT`);
    assert.ok(log.includes('COMPLETA_ASSEGNAZIONE'), `${name}: assegnazione non completata`);
  }
  if (expected.capture === false) assert.ok(!log.includes('STRIPE_CAPTURE'), `${name}: cattura inattesa`);
  if (expected.capture === true) assert.ok(log.includes('STRIPE_CAPTURE'), `${name}: cattura mancante`);
  if (expected.noStripe) assert.ok(!log.some(x => x.startsWith('STRIPE_')), `${name}: Stripe non deve essere chiamato`);
  if (expected.noAssignmentComplete) assert.ok(!log.includes('COMPLETA_ASSEGNAZIONE'), `${name}: assegnazione completata troppo presto`);
  if (log.includes('STRIPE_CAPTURE')) assert.ok(log.indexOf('CHECK_CONDUCENTE') < log.indexOf('STRIPE_CAPTURE'));
  if (log.includes('COMPLETA_ASSEGNAZIONE')) assert.ok(log.indexOf('COMPLETA_ASSEGNAZIONE') < log.indexOf('COMMIT') || expected.error);
  console.log(`OK - ${name}`);
}

try {
  await scenario('non assegnato: 403, nessuno Stripe',
    { authorized: false }, { error: true, status: 403, noStripe: true, noAssignmentComplete: true });
  await scenario('titolare non assegnato: 403, nessuno Stripe',
    { authorized: false, userId: 2 }, { error: true, status: 403, noStripe: true, noAssignmentComplete: true });
  await scenario('pagamento mancante: ROLLBACK prima di Stripe',
    { missingPayment: true }, { error: true, message: /pagamento mancante/, noStripe: true, noAssignmentComplete: true });
  await scenario('autorizzato: cattura e completamento',
    {}, { capture: true });
  await scenario('Stripe gia riuscito: riconciliazione senza ricattura',
    { piStatus: 'succeeded' }, { capture: false });
  await scenario('cattura fallita: ROLLBACK senza completamento',
    { captureError: true }, { error: true, capture: true, noAssignmentComplete: true });
  await scenario('DB fallisce dopo cattura: ROLLBACK (rischio riconciliazione)',
    { failAfterCapture: true }, { error: true, capture: true, noAssignmentComplete: true });
  await scenario('completamento assegnazione fallito: ROLLBACK',
    { failAssignment: true }, { error: true, capture: true });
  console.log('PASS - 8 scenari END simulati; DB/Redis/Stripe reali NON utilizzati');
} finally {
  delete globalThis.__turentuEndMocks;
}
