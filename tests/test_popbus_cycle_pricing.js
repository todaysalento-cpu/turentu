
import assert from 'node:assert/strict';

import {
  valutaEconomiaCiclo,
  COMMISSIONE_TURENTU_BPS
} from '../services/popbus/v2/cycle-pricing.js';

const cicloBase = {
  kmAvvicinamento: 5,
  kmMissioni: 20,
  kmTrasferimenti: 3,
  kmRitornoBase: 12,
  euroKm: 1.50,
  oreAttesa: 0,
  costoAttesaOraEuro: 0,
  altriCostiEuro: 0,
  margineMinimoEuro: 0
};

function valuta(nome, ricavi, overrides = {}) {
  const risultato = valutaEconomiaCiclo({
    ...cicloBase,
    ...overrides,
    ricaviRichiesteEuro: ricavi
  });

  console.log({
    scenario: nome,
    kmTotali: risultato.km.totali,
    ricavoLordo: risultato.ricavoLordoEuro,
    commissione: risultato.commissioneTurentuEuro,
    nettoOperatore: risultato.ricavoNettoEuro,
    compensoRichiesto: risultato.costoKmEuro,
    sogliaLorda: risultato.sogliaAttivazioneLordaEuro,
    margine: risultato.margineEuro,
    economicamenteAttivabile:
      risultato.economicamenteAttivabile
  });

  return risultato;
}

console.log('=== POPBUS V2 - TEST ECONOMIA CICLO ===');

assert.equal(COMMISSIONE_TURENTU_BPS, 1500);

// Scenario 1: ricavi sufficienti.
const sufficiente = valuta(
  'Ricavi sufficienti',
  [40, 40]
);

assert.equal(sufficiente.km.totali, 40);
assert.equal(sufficiente.costoKmEuro, 60);
assert.equal(sufficiente.commissioneTurentuEuro, 12);
assert.equal(sufficiente.ricavoNettoEuro, 68);
assert.equal(sufficiente.economicamenteAttivabile, true);

// Scenario 2: ricavi insufficienti.
const insufficiente = valuta(
  'Ricavi insufficienti',
  [35, 35]
);

assert.equal(insufficiente.ricavoNettoEuro, 59.50);
assert.equal(insufficiente.economicamenteAttivabile, false);

// Scenario 3: stesso ricavo, senza km di ritorno.
const senzaRitorno = valuta(
  'Confronto senza ritorno',
  [35, 35],
  { kmRitornoBase: 0 }
);

assert.equal(senzaRitorno.km.totali, 28);
assert.equal(senzaRitorno.costoKmEuro, 42);
assert.equal(senzaRitorno.economicamenteAttivabile, true);

// Il ritorno deve cambiare l'esito economico.
assert.equal(insufficiente.economicamenteAttivabile, false);
assert.equal(senzaRitorno.economicamenteAttivabile, true);

// Scenario 4: verifica soglia lorda esatta.
assert.equal(sufficiente.sogliaAttivazioneLordaEuro, 70.59);

console.log('\nPASS: economia del ciclo completo verificata.');
