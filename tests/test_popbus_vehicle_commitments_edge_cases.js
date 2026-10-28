// TURENTU — POPBUS V2
// TEST EDGE CASES: IMPEGNI FISICI DEI VEICOLI
//
// Nessuna connessione PostgreSQL.
// Nessuna scrittura.
// Nessuna modifica al worker LIVE.

import assert from 'node:assert/strict';

import {
  verificaConflittoInMemoria,
} from '../services/popbus/v2/vehicle-commitments-shadow.js';

const BASE = Date.parse('2026-11-01T10:00:00.000Z');
const MIN = 60_000;
const HOUR = 60 * MIN;

let passed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS ${String(passed).padStart(2, '0')} — ${name}`);
  } catch (error) {
    console.error(`FAIL — ${name}: ${error.message}`);
    throw error;
  }
}

function commitment(start, end, riferimento = '1') {
  return {
    origine: 'corsa',
    riferimento,
    start,
    end,
  };
}

function index(entries) {
  return {
    byVehicle: new Map(entries),
  };
}

const occupied = index([
  [361, [commitment(BASE, BASE + HOUR)]],
  [363, []],
]);

const check = (idx, vehicleId, start, end) =>
  verificaConflittoInMemoria(idx, vehicleId, start, end);

// 01 — Sovrapposizione completa
test('Sovrapposizione completa', () => {
  assert.equal(
    check(occupied, 361, BASE - HOUR, BASE + 2 * HOUR),
    true
  );
});

// 02 — Sovrapposizione iniziale
test('Sovrapposizione iniziale', () => {
  assert.equal(
    check(occupied, 361, BASE - 10 * MIN, BASE + 10 * MIN),
    true
  );
});

// 03 — Sovrapposizione finale
test('Sovrapposizione finale', () => {
  assert.equal(
    check(occupied, 361, BASE + 50 * MIN, BASE + 70 * MIN),
    true
  );
});

// 04 — Intervallo identico
test('Intervallo identico', () => {
  assert.equal(
    check(occupied, 361, BASE, BASE + HOUR),
    true
  );
});

// 05 — Adiacenza precedente
test('Adiacenza precedente senza conflitto', () => {
  assert.equal(
    check(occupied, 361, BASE - HOUR, BASE),
    false
  );
});

// 06 — Adiacenza successiva
test('Adiacenza successiva senza conflitto', () => {
  assert.equal(
    check(occupied, 361, BASE + HOUR, BASE + 2 * HOUR),
    false
  );
});

// 07 — Veicolo differente
test('Impegni separati per veicolo', () => {
  assert.equal(
    check(occupied, 363, BASE, BASE + HOUR),
    false
  );
});

// 08 — Arrivo NULL normalizzato a Infinity
test('Corsa senza arrivo: impegno aperto', () => {
  const idx = index([
    [361, [commitment(BASE, Infinity)]],
  ]);

  assert.equal(
    check(idx, 361, BASE + 24 * HOUR, BASE + 25 * HOUR),
    true
  );

  assert.equal(
    check(idx, 361, BASE - HOUR, BASE),
    false
  );
});

// 09 — Veicolo non caricato
test('Veicolo non presente: fail closed', () => {
  assert.throws(
    () => check(occupied, 999, BASE, BASE + HOUR),
    /non presente nell'indice/
  );
});

// 10 — Intervallo operativo invertito
test('Intervallo richiesto invertito: errore', () => {
  assert.throws(
    () => check(occupied, 361, BASE + HOUR, BASE),
    /intervallo operativo non valido/
  );
});

// 11 — Intervallo operativo nullo
test('Intervallo richiesto di durata zero: errore', () => {
  assert.throws(
    () => check(occupied, 361, BASE, BASE),
    /intervallo operativo non valido/
  );
});

// 12 — Impegni multipli ordinati
test('Ricerca su impegni multipli ordinati', () => {
  const idx = index([
    [361, [
      commitment(BASE, BASE + HOUR, '1'),
      commitment(BASE + 3 * HOUR, BASE + 4 * HOUR, '2'),
      commitment(BASE + 6 * HOUR, BASE + 7 * HOUR, '3'),
    ]],
  ]);

  assert.equal(
    check(idx, 361, BASE + 2 * HOUR, BASE + 3 * HOUR),
    false
  );

  assert.equal(
    check(idx, 361, BASE + 3 * HOUR, BASE + 3 * HOUR + MIN),
    true
  );
});

console.log(
  'POPBUS_COMMITMENTS_EDGE_CASES_RESULT:' +
  JSON.stringify({
    passed: passed === 12,
    tests: passed,
    expected: 12,
    dbWrites: 0,
  })
);