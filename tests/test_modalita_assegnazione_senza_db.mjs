// Turentu - test unitari senza connessione al database.
// Posizionare in tests/test_modalita_assegnazione_senza_db.mjs
// Eseguire: node tests\test_modalita_assegnazione_senza_db.mjs
import assert from 'node:assert/strict';
import { leggiImpostazioniAssegnazione, salvaImpostazioniAssegnazione } from '../services/conducenti/conducenti.service.js';
import { assegnaConducente } from '../services/conducenti/assegnazioni.service.js';

const MODALITA = ['manuale', 'automatica', 'titolare'];
const OP = 101;

function fakePool(initial = null) {
  const calls = [];
  let current = initial;
  let pending = null;
  const client = {
    async query(sql, params = []) {
      const s = String(sql).trim();
      calls.push({ sql: s, params });
      if (s === 'BEGIN') { pending = current; return { rows: [] }; }
      if (s.includes('pg_advisory_xact_lock')) {
        assert.deepEqual(params, [731904, OP]);
        return { rows: [{ pg_advisory_xact_lock: null }] };
      }
      if (s.includes('INSERT INTO impostazioni_assegnazione_operatori')) {
        pending = params[1];
        return { rows: [{ operatore_id: OP, modalita: pending, aggiornato_il: new Date() }] };
      }
      if (s === 'COMMIT') { current = pending; return { rows: [] }; }
      if (s === 'ROLLBACK') { pending = null; return { rows: [] }; }
      throw new Error('Query non prevista nel mock: ' + s);
    },
    release() { calls.push({ sql: 'RELEASE', params: [] }); }
  };
  return {
    calls,
    async connect() { calls.push({ sql: 'CONNECT', params: [] }); return client; },
    async query(sql, params = []) {
      calls.push({ sql: String(sql).trim(), params });
      if (String(sql).includes('SELECT operatore_id, modalita, aggiornato_il')) {
        return { rows: current === null ? [] : [{ operatore_id: OP, modalita: current, aggiornato_il: new Date() }] };
      }
      throw new Error('Query pool non prevista');
    }
  };
}

const db = fakePool();
assert.equal((await leggiImpostazioniAssegnazione(db, OP)).modalita, 'manuale');
console.log('PASS default manuale');

for (const modalita of MODALITA) {
  const before = db.calls.length;
  const saved = await salvaImpostazioniAssegnazione(db, { operatoreId: OP, modalita });
  assert.equal(saved.modalita, modalita);
  assert.equal((await leggiImpostazioniAssegnazione(db, OP)).modalita, modalita);
  const steps = db.calls.slice(before).map(x => x.sql);
  const begin = steps.indexOf('BEGIN');
  const lock = steps.findIndex(x => x.includes('pg_advisory_xact_lock'));
  const write = steps.findIndex(x => x.includes('INSERT INTO impostazioni_assegnazione_operatori'));
  const commit = steps.indexOf('COMMIT');
  const release = steps.indexOf('RELEASE');
  assert(begin >= 0 && begin < lock && lock < write && write < commit && commit < release);
  console.log('PASS salvataggio e lock: ' + modalita);
}

for (const modalita of ['altro', '', null]) {
  await assert.rejects(() => salvaImpostazioniAssegnazione(db, { operatoreId: OP, modalita }), err => err.status === 400);
}
console.log('PASS rifiuto modalita non valide');

// Simula la risposta PostgreSQL alla lettura della modalita.
// Il servizio deve rifiutare PRIMA di consultare veicoli, missioni o conducenti.
for (const configurata of MODALITA) {
  for (const richiesta of MODALITA.filter(x => x !== configurata)) {
    const queries = [];
    const client = {
      async query(sql, params = []) {
        const s = String(sql);
        queries.push(s);
        if (s.includes('pg_advisory_xact_lock')) {
          assert.deepEqual(params, [731904, OP]);
          return { rows: [] };
        }
        if (s.includes('SELECT modalita FROM impostazioni_assegnazione_operatori')) {
          return { rows: [{ modalita: configurata }] };
        }
        throw new Error('Query inattesa prima del blocco modalita: ' + s);
      }
    };
    const input = {
      operatoreId: OP, veicoloId: 201,
      inizio: '2030-06-01T08:00:00Z', fine: '2030-06-01T10:00:00Z',
      modalita: richiesta,
      ...(richiesta !== 'automatica' ? { conducenteId: richiesta === 'titolare' ? OP : 301 } : {})
    };
    await assert.rejects(() => assegnaConducente(client, input), err =>
      err.code === 'MODALITA_ASSEGNAZIONE_NON_CONSENTITA' && err.status === 409
    );
    assert.equal(queries.length, 2, 'Solo lock e lettura modalita');
    console.log(`PASS blocco modalita: configurata=${configurata}, richiesta=${richiesta}`);
  }
}
console.log('ESITO: TEST UNITARI SUPERATI - NESSUNA CONNESSIONE AL DATABASE');
console.log('NOTA: concorrenza reale, disponibilita e vincoli DB richiedono test su database isolato.');
