// ============================================================
// TURENTU POPBUS V2 — TEST UNITARI PRICING (NO DB, NO WORKER)
// Salvare come: tests/test_popbus_v2_cycle_pricing.js
// Eseguire dalla root: node tests/test_popbus_v2_cycle_pricing.js
// ============================================================
import assert from 'node:assert/strict';
import { valutaEconomiaCiclo, minimoLordoPerCostoCentesimi }
  from '../services/popbus/v2/cycle-pricing.js';

let passed = 0;
function test(nome, fn) {
  fn();
  passed++;
  console.log(`✅ ${nome}`);
}

function ciclo(overrides = {}) {
  return valutaEconomiaCiclo({
    ricaviRichiesteEuro: [100],
    kmAvvicinamento: 10,
    kmMissioni: 100,
    kmTrasferimenti: 0,
    kmRitornoBase: 70,
    euroKm: 0.5,
    oreAttesa: 0,
    costoAttesaOraEuro: 0,
    altriCostiEuro: 0,
    ...overrides
  });
}

console.log('TURENTU POPBUS V2 — TEST CYCLE PRICING (SOLO LETTURA)');

test('Commissione 15% e ritorno inclusi: 100 - 15 - 90 = -5', () => {
  const r = ciclo();
  assert.equal(r.km.totali, 180);
  assert.equal(r.costoCompletoEuro, 90);
  assert.equal(r.commissioneTurentuEuro, 15);
  assert.equal(r.margineEuro, -5);
  assert.equal(r.economicamenteAttivabile, false);
});

test('Pareggio netto esatto: lordo 100, costo 85', () => {
  const r = ciclo({ kmRitornoBase: 60, kmMissioni: 100 }); // 170 km * 0.5 = 85
  assert.equal(r.costoCompletoEuro, 85);
  assert.equal(r.margineEuro, 0);
  assert.equal(r.economicamenteAttivabile, true);
});

test('Un centesimo sotto il pareggio viene respinto', () => {
  const r = ciclo({ euroKm: 0, altriCostiEuro: 85.01 });
  assert.equal(r.margineEuro, -0.01);
  assert.equal(r.economicamenteAttivabile, false);
});

test('Un centesimo sopra il pareggio viene accettato', () => {
  const r = ciclo({ euroKm: 0, altriCostiEuro: 84.99 });
  assert.equal(r.margineEuro, 0.01);
  assert.equal(r.economicamenteAttivabile, true);
});

test('Concatenazione: una sola partenza e un solo ritorno, trasferimento incluso', () => {
  const r = ciclo({ ricaviRichiesteEuro: [30, 30], kmAvvicinamento: 4,
    kmMissioni: 20, kmTrasferimenti: 2, kmRitornoBase: 3, euroKm: 1 });
  assert.equal(r.km.totali, 29);
  assert.equal(r.costoCompletoEuro, 29);
  assert.equal(r.commissioneTurentuEuro, 9);
  assert.equal(r.margineEuro, 22);
});

test('Attesa e costi aggiuntivi incidono sul margine una volta sola', () => {
  const r = ciclo({ euroKm: 0, oreAttesa: 1.5, costoAttesaOraEuro: 10,
    altriCostiEuro: 5 });
  assert.equal(r.costoAttesaEuro, 15);
  assert.equal(r.costoCompletoEuro, 20);
  assert.equal(r.margineEuro, 65);
});

test('Arrotondamento costo chilometrico al centesimo superiore', () => {
  const r = ciclo({ kmAvvicinamento: 0, kmMissioni: 1,
    kmTrasferimenti: 0, kmRitornoBase: 0, euroKm: 0.501 });
  assert.equal(r.costoKmEuro, 0.51);
});

test('Commissione calcolata sul totale delle richieste', () => {
  const r = ciclo({ ricaviRichiesteEuro: [0.03, 0.03], euroKm: 0 });
  assert.equal(r.centesimi.ricavoLordo, 6);
  assert.equal(r.centesimi.commissione, 1);
  assert.equal(r.centesimi.ricavoNetto, 5);
});

test('Soglia minima lorda soddisfa la disuguaglianza in centesimi', () => {
  for (const costo of [1, 2, 3, 85, 100, 33861, 99999]) {
    const lordo = minimoLordoPerCostoCentesimi(costo);
    assert.ok(lordo - Math.round(lordo * 0.15) >= costo);
    assert.ok(lordo === 0 || (lordo - 1) - Math.round((lordo - 1) * 0.15) < costo);
  }
});

test('Margine minimo configurabile', () => {
  const r = ciclo({ kmRitornoBase: 60, margineMinimoEuro: 1 });
  assert.equal(r.margineEuro, 0);
  assert.equal(r.economicamenteAttivabile, false);
});

test('Componenti chilometriche mancanti vengono rifiutate', () => {
  assert.throws(() => valutaEconomiaCiclo({ ricaviRichiesteEuro: [100],
    kmAvvicinamento: 1, kmMissioni: 10, kmTrasferimenti: 0,
    euroKm: 0.5 }), /kmRitornoBase/);
});

test('Importi negativi, NaN e commissione invalida vengono rifiutati', () => {
  assert.throws(() => ciclo({ kmRitornoBase: -1 }), /kmRitornoBase/);
  assert.throws(() => ciclo({ euroKm: NaN }), /euroKm/);
  assert.throws(() => ciclo({ commissionBps: 10000 }), /commissionBps/);
});

console.log(`\n✅ ${passed}/${passed} TEST SUPERATI — nessuna operazione DB`);
