// TURENTU POPBUS P0-C4 — TEST DIAGNOSTICO ATOMICITA' (SIMULAZIONE)
// Rinominare .txt in .mjs e collocare in tests/.
// NON importa/esegue acceptance.js; simula il contratto transazionale del router.
// Non prova il rollback o i lock di PostgreSQL reale, né Stripe.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync('services/popbus/v2/acceptance.js', 'utf8');
let pass = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log('PASS ' + name); }
  catch (e) { console.error('FAIL ' + name + ': ' + e.message); process.exitCode = 1; }
}

// Replica minima dello stato SQL per verificare la semantica desiderata
// della transazione gestita dal router. Nessuna query viene inviata al DB.
function initialState() {
  return {
    corse: [], prenotazioni: [], pagamenti: [],
    richieste: [{id:101,stato:'in_lavorazione',corsa_id:null,posti:2},
               {id:102,stato:'in_lavorazione',corsa_id:null,posti:3},
               {id:103,stato:'in_lavorazione',corsa_id:null,posti:2}],
    offerte: [{id:1,veicolo_id:353,stato:'inviata',corsa_id:null},
              {id:2,veicolo_id:353,stato:'inviata',corsa_id:null}],
    attivazioni: [{id:1,stato:'in_attesa_autista',corsa_id:null}],
    nextCorsa: 1, nextPrenotazione: 1,
  };
}
const clone = x => structuredClone(x);
const assign = (target, source) => { for (const key of Object.keys(target)) delete target[key]; Object.assign(target, source); };
async function transaction(db, fn) {
  const working = clone(db);
  const result = await fn(working); // Eccezione => nessun commit
  assign(db, working);
  return result;
}
async function convert(db, {offertaId=1, failAt=null}={}) {
  return transaction(db, async tx => {
    const offer = tx.offerte.find(o => o.id===offertaId);
    if (!offer) throw Error('Offerta assente');
    if (offer.stato==='accettata' && offer.corsa_id) return {id:offer.corsa_id,giaAccettata:true};
    if (offer.stato!=='inviata') throw Error('Offerta non disponibile');
    if (tx.corse.some(c => c.veicolo_id===offer.veicolo_id)) throw Error('Veicolo occupato');
    if (tx.richieste.some(r => r.stato!=='in_lavorazione' || r.corsa_id!==null)) throw Error('Richieste non disponibili');
    const corsa = {id:tx.nextCorsa++,veicolo_id:offer.veicolo_id,posti_totali:4,posti_prenotati:7,posti_disponibili:1};
    tx.corse.push(corsa);
    if (failAt==='corsa') throw Error('Errore simulato dopo corsa');
    for (let i=0;i<tx.richieste.length;i++) {
      const r=tx.richieste[i];
      const p={id:tx.nextPrenotazione++,corsa_id:corsa.id,richiesta_id:r.id,posti_richiesti:r.posti};
      tx.prenotazioni.push(p);
      if (failAt===`prenotazione_${i+1}`) throw Error('Errore simulato prenotazione');
      tx.pagamenti.push({id:i+1,prenotazione_id:p.id,corsa_id:corsa.id,stato:'autorizzazione'});
      if (failAt===`pagamento_${i+1}`) throw Error('Errore simulato pagamento');
      r.stato='convertita'; r.corsa_id=corsa.id;
    }
    tx.attivazioni[0].stato='confermata'; tx.attivazioni[0].corsa_id=corsa.id;
    offer.stato='accettata'; offer.corsa_id=corsa.id;
    if (failAt==='conferma') throw Error('Errore simulato conferma');
    return {id:corsa.id};
  });
}

await test('Contratto: acceptance non gestisce BEGIN/COMMIT/ROLLBACK', () => {
  assert.doesNotMatch(source, /await\s+client\.query\(\s*['"`]\s*(?:BEGIN|COMMIT|ROLLBACK)\b/i);
  assert.match(source,/pg_advisory_xact_lock/);
});
await test('Contratto: una INSERT corse e INSERT per prenotazioni e pagamenti', () => {
  assert.equal((source.match(/INSERT INTO corse\s*\(/g)||[]).length,1);
  assert.match(source,/INSERT INTO prenotazioni/);
  assert.match(source,/INSERT INTO pagamenti/);
});
await test('Contratto: flag multi-missione OFF salvo abilitazione esplicita', () => {
  assert.match(source,/process\.env\.POPBUS_MULTIMISSION_ACCEPTANCE_TEST === 'true'/);
});
await test('SIMULAZIONE: conversione completa 1 corsa, 3 prenotazioni, 3 pagamenti', async () => {
  const db=initialState(); await convert(db);
  assert.equal(db.corse.length,1); assert.equal(db.prenotazioni.length,3); assert.equal(db.pagamenti.length,3);
  assert.deepEqual(db.richieste.map(r=>r.stato),['convertita','convertita','convertita']);
  assert.equal(db.corse[0].posti_disponibili,1); // 4 - peak(3), non 4 - totale(7)
});
for (const stage of ['corsa','prenotazione_1','prenotazione_2','prenotazione_3','pagamento_1','pagamento_2','pagamento_3','conferma']) {
  await test(`SIMULAZIONE: errore ${stage} annulla tutte le modifiche`, async () => {
    const db=initialState(), before=clone(db);
    await assert.rejects(convert(db,{failAt:stage}),/Errore simulato/);
    assert.deepEqual(db,before);
  });
}
await test('SIMULAZIONE: doppia accettazione stessa offerta idempotente',async()=>{
  const db=initialState(); const first=await convert(db); const second=await convert(db);
  assert.equal(second.giaAccettata,true); assert.equal(second.id,first.id);
  assert.equal(db.corse.length,1); assert.equal(db.pagamenti.length,3);
});
await test('SIMULAZIONE: seconda offerta stesso veicolo non duplica la corsa',async()=>{
  const db=initialState(); await convert(db);
  await assert.rejects(convert(db,{offertaId:2}),/Veicolo occupato/);
  assert.equal(db.corse.length,1);
});
await test('SIMULAZIONE: richiesta già convertita blocca nuova conversione',async()=>{
  const db=initialState(); db.richieste[1].stato='convertita';
  const before=clone(db);
  await assert.rejects(convert(db),/Richieste non disponibili/);
  assert.deepEqual(db,before);
});
console.log(`ESITO: ${pass} PASS, ${process.exitCode ? 'FAIL presenti' : '0 FAIL'}.`);
console.log('LIMITI: simulazione autonoma, NON esegue acceptance.js, NON verifica lock concorrenti PostgreSQL, Stripe o rollback reale.');
if(process.exitCode) process.exit(process.exitCode);
