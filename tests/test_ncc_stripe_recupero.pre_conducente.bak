// TEST NCC MODELLO A - Stripe simulato, DB simulato, nessuna rete.
// Copiare in tests/test_ncc_stripe_recupero.mjs ed eseguire: node tests/test_ncc_stripe_recupero.mjs
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';

const SOURCE = path.resolve('services/corsa/corse.service.js');
const original = await fs.readFile(SOURCE, 'utf8');
assert.match(original, /export async function toggleCorsa\(/, 'Servizio toggleCorsa non trovato');
// Rimuove gli import statici anche se il file sorgente contiene indentazione
// o terminazioni CRLF; il mock dichiara già pool/Stripe/dipendenze.
const cleaned = original
  .replace(/^[ \t]*import\b[^;]*;[ \t]*(?:\r?\n)?/gm, '')
  .replace(/^[ \t]*const stripe = new Stripe\([^\n]*\);[ \t]*(?:\r?\n)?/gm, '');
assert.ok(!/^[ \t]*import\b/m.test(cleaned), 'Import non riconosciuto');
const state = { scenario: '', failOn: null, db: null, stripe: null, calls: [], queries: [], commits: 0, rollbacks: 0 };
const deep = x => structuredClone(x);
function initial() {
  return {
    corsa: { id: 991001, stato: 'in_corso', tipo_corsa: 'condivisa', prezzo_fisso: 67.65, prenotazione_origine_id: 991011, distanza: 100 },
    prenotazioni: [
      { id: 991011, corsa_id: 991001, prezzo_totale: 30.75, posti_richiesti: 1, km_utente: 100, start_offset: 0, end_offset: 100000 },
      { id: 991012, corsa_id: 991001, prezzo_totale: 18.45, posti_richiesti: 1, km_utente: 60, start_offset: 20000, end_offset: 80000 },
      { id: 991013, corsa_id: 991001, prezzo_totale: 18.45, posti_richiesti: 1, km_utente: 60, start_offset: 40000, end_offset: 100000 }
    ],
    pagamenti: [
      { id: 991021, prenotazione_id: 991011, corsa_id: 991001, stato: 'autorizzazione', importo: 67.65, stripe_payment_intent: 'pi_test_A' },
      { id: 991022, prenotazione_id: 991012, corsa_id: 991001, stato: 'autorizzazione', importo: 25.37, stripe_payment_intent: 'pi_test_B' },
      { id: 991023, prenotazione_id: 991013, corsa_id: 991001, stato: 'autorizzazione', importo: 18.45, stripe_payment_intent: 'pi_test_C' }
    ]
  };
}
const stripe = { paymentIntents: {
  async retrieve(id) {
    const pi = state.stripe[id];
    if (!pi) throw Error('PI inesistente: ' + id);
    return deep({ id, ...pi });
  },
  async capture(id, opts, requestOpts) {
    state.calls.push({ id, amount: opts.amount_to_capture, key: requestOpts?.idempotencyKey });
    if (state.failOn === id) { state.failOn = null; throw Error('ERRORE_STRIPE_SIMULATO_' + id); }
    const pi = state.stripe[id];
    if (pi.status !== 'requires_capture' || opts.amount_to_capture > pi.amount_capturable) throw Error('Cattura non valida');
    pi.status = 'succeeded'; pi.amount_received = opts.amount_to_capture; pi.amount_capturable = 0;
    return deep({ id, ...pi });
  }
}};
const client = {
  async query(sql, args = []) {
    const q = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    state.queries.push(q);
    if (q === 'begin') { state.snapshot = deep(state.db); return { rows: [] }; }
    if (q === 'commit') { state.commits++; state.snapshot = null; return { rows: [] }; }
    if (q === 'rollback') { state.rollbacks++; state.db = state.snapshot; state.snapshot = null; return { rows: [] }; }
    if (q.startsWith('savepoint ') || q.startsWith('release savepoint ') || q.startsWith('rollback to savepoint ')) return { rows: [] };
    if (q.startsWith('update public.corse set "stato" = $1 where id = $2 and "stato" = $3 returning *')) {
      const [next, id, expected] = args;
      if (state.db.corsa.id !== Number(id) || state.db.corsa.stato !== expected) {
        return { rows: [] };
      }
      state.db.corsa.stato = next;
      return { rows: [deep(state.db.corsa)] };
    }
    if (q.startsWith('select stato from public.corse where id = $1')) {
      return { rows: state.db.corsa.id === Number(args[0]) ? [{ stato: state.db.corsa.stato }] : [] };
    }
    if (q.includes('from public.prenotazioni pr left join public.pagamenti p')) {
      return { rows: state.db.prenotazioni.flatMap(pr => {
        const payments = state.db.pagamenti.filter(p => p.prenotazione_id === pr.id && p.corsa_id === pr.corsa_id);
        return (payments.length ? payments : [null]).map(p => ({
          prenotazione_id: pr.id, prezzo_totale: pr.prezzo_totale,
          pagamento_id: p?.id ?? null, stato_pagamento: p?.stato ?? null,
          stripe_payment_intent: p?.stripe_payment_intent ?? null,
          importo_pagato: p?.importo ?? null
        }));
      }) };
    }
    if (q.includes('from public.pagamenti p left join public.prenotazioni pr')) {
      return { rows: state.db.pagamenti.filter(p => !state.db.prenotazioni.some(pr => pr.id === p.prenotazione_id && pr.corsa_id === p.corsa_id)).slice(0,1).map(p => ({id:p.id})) };
    }
    if (q.includes('from public.pagamenti p join public.prenotazioni pr')) {
      const onlyAuthorized = !q.includes("p.stato = 'pagato'");
      return { rows: state.db.pagamenti.filter(p => !onlyAuthorized || p.stato === 'autorizzazione').map(p => {
        const pr = state.db.prenotazioni.find(x => x.id === p.prenotazione_id);
        return { pagamento_id:p.id, stripe_payment_intent:p.stripe_payment_intent, prenotazione_id:p.prenotazione_id,
          importo_db:p.importo, stato_pagamento:p.stato, posti_richiesti:pr.posti_richiesti, cliente_id:1,
          start_offset:pr.start_offset, end_offset:pr.end_offset, km_utente:pr.km_utente, prezzo_totale:pr.prezzo_totale };
      }) };
    }
    if (q.includes('select id, prezzo_totale from public.prenotazioni')) return { rows: deep(state.db.prenotazioni.map(p => ({ id:p.id, prezzo_totale:p.prezzo_totale }))) };
    if (q.includes('select p.id, p.prenotazione_id, p.stato, p.stripe_payment_intent')) return { rows: deep(state.db.pagamenti) };
    if (q.includes('select id, posti_richiesti, km_utente, start_offset, end_offset from public.prenotazioni')) return { rows: deep(state.db.prenotazioni) };
    if (q.startsWith('update public.pagamenti set stato')) {
      const p = state.db.pagamenti.find(x => x.id === Number(args.at(-1)));
      if (!p) throw Error('Pagamento non trovato');
      p.stato = q.includes("stato = 'pagato'") ? 'pagato' : args[0];
      if (q.includes('importo = $1')) p.importo = args[0];
      return { rows: [] };
    }
    throw Error('SQL non simulato: ' + q.slice(0, 180));
  }, release() {}
};
const pool = { connect: async () => client };
const CacheManager = { corsa: { update() {} } };
const removeCorsa = async () => {};
const getTariffe = async () => { throw Error('getTariffe non previsto nel test'); };
const calcolaPrezzo = async () => { throw Error('Pricing legacy non deve essere usato per Modello A'); };
// Esegue il CODICE DEL SERVIZIO caricato dal disco, con sole dipendenze sostituite.
// Non importa db.js, Stripe SDK o altre dipendenze: impossibile raggiungere DB/Stripe reali.
const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(
  `const {pool,stripe,CacheManager,removeCorsa,getTariffe,calcolaPrezzo} = globalThis.__TURENTU_TEST_MOCK__;\n` + cleaned
).toString('base64');
globalThis.__TURENTU_TEST_MOCK__ = { pool, stripe, CacheManager, removeCorsa, getTariffe, calcolaPrezzo };
const { toggleCorsa } = await import(moduleUrl);
function reset() {
  state.db = initial(); state.stripe = {
    pi_test_A: { status:'requires_capture', amount_capturable:6765, amount_received:0 },
    pi_test_B: { status:'requires_capture', amount_capturable:2537, amount_received:0 },
    pi_test_C: { status:'requires_capture', amount_capturable:1845, amount_received:0 }
  };
  state.calls = []; state.queries = []; state.failOn = null; state.commits = 0; state.rollbacks = 0;
}
let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); console.log('PASS', name); pass++; }
  catch (e) { console.error('FAIL', name, '-', e.message); fail++; }
}
console.log('\nTURENTU NCC - TEST STRIPE MOCK ISOLATO (NESSUNA RETE)\n');
reset();
await check('Cattura completa Modello A', async () => {
  await toggleCorsa(991001, 'end');
  assert.equal(state.db.corsa.stato, 'completata');
  assert.deepEqual(state.calls.map(x => x.amount), [3075,1845,1845]);
  assert.deepEqual(state.db.pagamenti.map(x => Math.round(x.importo*100)), [3075,1845,1845]);
  assert.ok(state.db.pagamenti.every(x => x.stato === 'pagato'));
  assert.equal(state.commits, 1);
});
await check('Idempotency key presente su ogni cattura', async () => {
  assert.ok(state.calls.every(x => typeof x.key === 'string' && x.key.startsWith('turentu-corsa-')));
});
reset(); state.failOn = 'pi_test_B';
await check('Errore intermedio: rollback DB, incasso A rimane su Stripe', async () => {
  await assert.rejects(toggleCorsa(991001, 'end'), /ERRORE_STRIPE_SIMULATO/);
  assert.equal(state.db.corsa.stato, 'in_corso');
  assert.ok(state.db.pagamenti.every(x => x.stato === 'autorizzazione'));
  assert.equal(state.stripe.pi_test_A.status, 'succeeded');
  assert.equal(state.stripe.pi_test_B.status, 'requires_capture');
  assert.deepEqual(state.calls.map(x => x.id), ['pi_test_A','pi_test_B']);
  assert.equal(state.rollbacks, 1);
});
await check('Retry: riconcilia A, cattura solo B e C', async () => {
  const prev = state.calls.length;
  await toggleCorsa(991001, 'end');
  assert.deepEqual(state.calls.slice(prev).map(x => x.id), ['pi_test_B','pi_test_C']);
  assert.deepEqual(state.db.pagamenti.map(x => Math.round(x.importo*100)), [3075,1845,1845]);
  assert.ok(state.db.pagamenti.every(x => x.stato === 'pagato'));
  assert.equal(state.db.corsa.stato, 'completata');
});
reset(); state.stripe.pi_test_A.status = 'succeeded'; state.stripe.pi_test_A.amount_received = 3000; state.stripe.pi_test_A.amount_capturable = 0;
await check('Incasso già effettuato ma errato: blocco preventivo', async () => {
  await assert.rejects(toggleCorsa(991001, 'end'), /Modello A/);
  assert.equal(state.calls.length, 0);
  assert.equal(state.db.corsa.stato, 'in_corso');
});
reset(); state.stripe.pi_test_B.amount_capturable = 100;
await check('Autorizzazione insufficiente: nessuna cattura', async () => {
  await assert.rejects(toggleCorsa(991001, 'end'), /Modello A/);
  assert.equal(state.calls.length, 0);
});
reset(); state.db.prenotazioni[2].prezzo_totale = 18.44;
await check('Quote non quadrate: nessuna cattura', async () => {
  await assert.rejects(toggleCorsa(991001, 'end'), /ripartizione non quadrata/);
  assert.equal(state.calls.length, 0);
});

// Verifiche delle transizioni introdotte nel servizio.
reset(); state.db.corsa.stato = 'accettata';
await check('Start: accettata -> in_corso, nessuna cattura', async () => {
  await toggleCorsa(991001, 'start');
  assert.equal(state.db.corsa.stato, 'in_corso');
  assert.equal(state.calls.length, 0);
  assert.equal(state.commits, 1);
});
await check('Start ripetuto: rifiutato senza cattura', async () => {
  await assert.rejects(toggleCorsa(991001, 'start'), /Transizione non consentita/);
  assert.equal(state.db.corsa.stato, 'in_corso');
  assert.equal(state.calls.length, 0);
});
reset(); state.db.corsa.stato = 'accettata';
await check('End anticipato: accettata -> completata bloccato', async () => {
  await assert.rejects(toggleCorsa(991001, 'end'), /Transizione non consentita/);
  assert.equal(state.db.corsa.stato, 'accettata');
  assert.equal(state.calls.length, 0);
});
reset(); state.db.corsa.stato = 'completata';
await check('Start su completata: bloccato', async () => {
  await assert.rejects(toggleCorsa(991001, 'start'), /Transizione non consentita/);
  assert.equal(state.db.corsa.stato, 'completata');
  assert.equal(state.calls.length, 0);
});
reset();
await check('End ripetuto: nessuna seconda cattura', async () => {
  await toggleCorsa(991001, 'end');
  const firstCount = state.calls.length;
  await assert.rejects(toggleCorsa(991001, 'end'), /Transizione non consentita/);
  assert.equal(state.calls.length, firstCount);
  assert.equal(state.db.corsa.stato, 'completata');
  assert.ok(state.db.pagamenti.every(p => p.stato === 'pagato'));
});
reset();
await check('Corsa inesistente: rifiutata senza catture', async () => {
  await assert.rejects(toggleCorsa(999999, 'end'), /non trovata/);
  assert.equal(state.calls.length, 0);
});

reset(); state.db.pagamenti.pop();
await check('Pagamento mancante: chiusura bloccata senza catture', async () => {
  await assert.rejects(toggleCorsa(991001, 'end'), /pagamento mancante/);
  assert.equal(state.calls.length, 0);
  assert.equal(state.db.corsa.stato, 'in_corso');
});
reset(); state.db.pagamenti.push({...state.db.pagamenti[0], id:991099});
await check('Pagamento duplicato: chiusura bloccata senza catture', async () => {
  await assert.rejects(toggleCorsa(991001, 'end'), /pagamenti duplicati/);
  assert.equal(state.calls.length, 0);
});
reset(); state.db.pagamenti[0].stato = 'annullato';
await check('Stato pagamento non ammesso: chiusura bloccata', async () => {
  await assert.rejects(toggleCorsa(991001, 'end'), /stato pagamento non ammesso/);
  assert.equal(state.calls.length, 0);
});
reset(); state.db.pagamenti[0].stato = 'pagato'; state.db.pagamenti[0].importo = 30.75;
state.stripe.pi_test_A.status = 'succeeded'; state.stripe.pi_test_A.amount_received = 3075;
await check('Pagamento gia pagato: verifica Stripe e cattura solo altri', async () => {
  await toggleCorsa(991001, 'end');
  assert.deepEqual(state.calls.map(x => x.id), ['pi_test_B','pi_test_C']);
  assert.equal(state.db.corsa.stato, 'completata');
});
reset(); state.db.pagamenti[0].stato = 'pagato'; state.db.pagamenti[0].importo = 30.75;
await check('Pagamento pagato senza incasso Stripe: blocco', async () => {
  await assert.rejects(toggleCorsa(991001, 'end'), /incasso Stripe non riconciliato/);
  assert.equal(state.calls.length, 0);
});
reset(); state.db.pagamenti.push({id:991099, prenotazione_id:999999, corsa_id:991001, stato:'pagato', stripe_payment_intent:'pi_test_X', importo:10});
await check('Pagamento orfano: chiusura bloccata', async () => {
  await assert.rejects(toggleCorsa(991001, 'end'), /pagamento senza prenotazione/);
  assert.equal(state.calls.length, 0);
});

console.log(`\nRISULTATO: ${pass} PASS / ${fail} FAIL`);
if (fail) process.exitCode = 1;
