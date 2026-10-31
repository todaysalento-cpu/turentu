// TURENTU - Test anagrafica conducenti, transazione ROLLBACK_ONLY.
// Collocare in tests/test_anagrafica_conducenti_rollback.mjs
// Eseguire: node --env-file=.env tests/test_anagrafica_conducenti_rollback.mjs
// Non avvia server HTTP e non testa autenticazione/router; testa il servizio e il DB reale.
import assert from 'node:assert/strict';
import { pool } from '../db/db.js';
import {
  elencoAnagraficheConducenti,
  creaAnagraficaConducente,
  modificaAnagraficaConducente,
  disattivaAnagraficaConducente
} from '../services/conducenti/anagrafica.service.js';

const check = (cond, description) => { assert.ok(cond, description); console.log(`PASS ${description}`); };
let client;
let started = false;
let failure = null;
try {
  // Protezione esplicita contro esecuzioni accidentali.
  assert.equal(process.env.TURENTU_ALLOW_ANAGRAFICA_ROLLBACK_TEST, 'YES',
    'Impostare TURENTU_ALLOW_ANAGRAFICA_ROLLBACK_TEST=YES per autorizzare il test');
  client = await pool.connect();
  const exists = await client.query("SELECT to_regclass('public.anagrafica_conducenti') AS t");
  check(exists.rows[0].t !== null, 'Tabella anagrafica presente');
  const operators = await client.query("SELECT id FROM public.utente WHERE tipo='autista' ORDER BY id LIMIT 2");
  if (!operators.rows.length) throw new Error('Nessun account operatore (utente.tipo=autista) disponibile');
  const operatorId = operators.rows[0].id;
  const otherId = operators.rows[1]?.id;
  await client.query('BEGIN');
  started = true;
  const suffix = `${process.pid}-${Date.now()}`;
  const created = await creaAnagraficaConducente(client, {
    operatoreId: operatorId,
    body: { nome: 'Test', cognome: 'Rollback', email: `test-rollback-${suffix}@example.invalid`,
      telefono: '0000000000', categoria_patente: 'B', data_nascita: '1990-01-15' }
  });
  check(created.id && created.operatore_id === operatorId && created.stato === 'bozza' && created.utente_id === null,
    'Salva: nuova bozza senza account Turentu');
  const all = await elencoAnagraficheConducenti(client, operatorId);
  check(all.some(row => String(row.id) === String(created.id)), 'Elenca: visibile al proprio operatore');
  if (otherId) {
    const others = await elencoAnagraficheConducenti(client, otherId);
    check(!others.some(row => String(row.id) === String(created.id)), 'Isolamento: invisibile a un altro operatore');
    await assert.rejects(() => modificaAnagraficaConducente(client, {
      operatoreId: otherId, anagraficaId: created.id, body: { nome: 'Intruso' }
    }), err => err.status === 409);
    check(true, 'Isolamento: modifica di un altro operatore rifiutata');
  } else {
    console.log('SKIP isolamento fra operatori: un solo operatore presente');
  }
  const updated = await modificaAnagraficaConducente(client, {
    operatoreId: operatorId, anagraficaId: created.id, body: { cognome: 'RollbackModificato' }
  });
  check(updated.cognome === 'RollbackModificato', 'Modifica: aggiorna anagrafica in bozza');
  await assert.rejects(() => creaAnagraficaConducente(client, {
    operatoreId: operatorId, body: { nome: 'Test', cognome: 'No', stato: 'collegato' }
  }), err => err.status === 400);
  check(true, 'Validazione: il client non puo impostare lo stato o il collegamento');
  const disabled = await disattivaAnagraficaConducente(client, {
    operatoreId: operatorId, anagraficaId: created.id
  });
  check(disabled.stato === 'disattivato', 'Disattiva: la bozza viene disattivata');
  await assert.rejects(() => modificaAnagraficaConducente(client, {
    operatoreId: operatorId, anagraficaId: created.id, body: { nome: 'NonConsentito' }
  }), err => err.status === 409);
  check(true, 'Protezione: anagrafica disattivata non modificabile');
  console.log('TEST COMPLETATO: nessuna modifica sara mantenuta');
} catch (err) {
  failure = err;
  console.error('TEST FALLITO:', err);
} finally {
  if (client) {
    if (started) {
      try { await client.query('ROLLBACK'); console.log('ROLLBACK eseguito'); }
      catch (e) { console.error('ERRORE ROLLBACK:', e); failure ??= e; }
    }
    client.release();
  }
  await pool.end();
}
if (failure) process.exitCode = 1;
