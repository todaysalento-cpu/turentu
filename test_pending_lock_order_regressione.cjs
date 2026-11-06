'use strict';
const fs = require('node:fs');
const assert = require('node:assert/strict');
const file = 'routes/pending.routes.js';
const source = fs.readFileSync(file, 'utf8');
const start = source.indexOf("router.post('/:id/accetta'");
assert(start >= 0, 'Rotta POST /:id/accetta assente');
const route = source.slice(start);
const pos = (re, name) => {
  const m = re.exec(route);
  assert(m, `${name} assente`);
  return m.index;
};
try {
  const begin = pos(/await client\.query\('BEGIN'\)/, 'BEGIN');
  const preliminary = pos(/SELECT\s+veicolo_id\s+FROM\s+pending\s+WHERE\s+id\s*=\s*\$1(?!\s+FOR\s+UPDATE)/i, 'Lettura preliminare');
  const vehicleLock = pos(/await bloccaVeicoloPerAssegnazione\(client,\s*veicoloIdPreliminare\)/, 'Lock veicolo');
  const pendingLock = pos(/FROM\s+pending\s+WHERE\s+id\s*=\s*\$1\s+FOR\s+UPDATE/i, 'Lock pending');
  const vehicleRecheck = pos(/Number\(p\.veicolo_id\)\s*!==\s*veicoloIdPreliminare/, 'Rivalidazione veicolo');
  const changedResponse = pos(/PENDING_VEHICLE_CHANGED/, 'Errore cambio veicolo');
  const arGuard = pos(/p\.ar_vincolata\s*===\s*true/, 'Blocco A\/R');
  const arResponse = pos(/AR_COORDINATED_ACCEPTANCE_REQUIRED/, 'Errore A\/R');
  const update = pos(/UPDATE\s+pending\s+SET\s+stato\s*=\s*'accettata'/i, 'Aggiornamento pending');
  const commit = pos(/await client\.query\('COMMIT'\)/, 'COMMIT');
  assert(begin < preliminary && preliminary < vehicleLock && vehicleLock < pendingLock && pendingLock < vehicleRecheck && vehicleRecheck < arGuard && arGuard < update && update < commit, 'Ordine delle operazioni non valido');
  assert(vehicleRecheck < changedResponse && changedResponse < arGuard && arGuard < arResponse && arResponse < update, 'Controlli di protezione non collocati prima dell’UPDATE');
  const lockCalls = [...route.slice(0, update).matchAll(/bloccaVeicoloPerAssegnazione\s*\(/g)];
  assert.equal(lockCalls.length, 1, 'Lock veicolo duplicato prima dell’UPDATE');
  console.log('PASS lettura preliminare senza FOR UPDATE');
  console.log('PASS ordine lock veicolo -> pending');
  console.log('PASS rivalidazione veicolo e risposta 409');
  console.log('PASS blocco A/R vincolato prima dell’UPDATE');
  console.log('PASS lock veicolo non duplicato');
  console.log('PASS UPDATE e COMMIT successivi ai controlli');
  console.log('ESITO_FINALE PASS (verifica statica, nessuna connessione DB)');
} catch (e) {
  console.error('ESITO_FINALE FAIL:', e.message);
  process.exitCode = 1;
}
