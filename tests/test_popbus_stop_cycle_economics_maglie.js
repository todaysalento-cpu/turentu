
import assert from 'node:assert/strict';

import { adattaMissioneFermate }
  from '../services/popbus/v2/popbus-stop-mission-adapter.service.js';

import { componiCicloInCorsa }
  from '../services/popbus/v2/popbus-single-corsa-assembler.js';

import { valutaEconomiaCicloFermate }
  from '../services/popbus/v2/popbus-stop-cycle-economics-adapter.service.js';

const BASE = Date.parse('2026-11-01T10:00:00+01:00');

const richiestaId = 900001;

const richieste = [
  { id: richiestaId, posti_richiesti: 2 }
];

const f14 = {
  fermata_id: 14,
  nome: 'Maglie - Piazzale Megapark',
  lat: 40.121583,
  lon: 18.305914
};

const f15 = {
  fermata_id: 15,
  nome: 'Maglie - Stazione ferroviaria',
  lat: 40.1258486502909,
  lon: 18.299920672780097
};

// Geometria segnaposto: test strutturale, non stradale.
const alternativa = {
  sequenza: { ok: true },
  temporale: { ok: true },
  qualita: { ok: true },
  itinerario: {
    ok: true,
    routingVerificato: true,
    departure: BASE,
    fineOperazioni: BASE + 238000,
    visite: [
      {
        ...f14,
        arrivo: BASE,
        partenza: BASE + 50000,
        sostaSecondi: 50,
        eventi: [{
          richiesta_id: richiestaId,
          tipo: 'salita',
          posti: 2,
          timestampOperazione: BASE
        }]
      },
      {
        ...f15,
        arrivo: BASE + 188000,
        partenza: BASE + 238000,
        sostaSecondi: 50,
        eventi: [{
          richiesta_id: richiestaId,
          tipo: 'discesa',
          posti: 2,
          timestampOperazione: BASE + 188000
        }]
      }
    ],
    legs: [{
      metres: 869,
      seconds: 138,
      polyline: 'test-polyline'
    }]
  }
};

console.log(
  '=== POPBUS V2 - ECONOMIA INTEGRATA FERMATE ==='
);

// 1. Adattamento della missione.
const adattata = adattaMissioneFermate({
  alternativa,
  richieste,
  corridorId: 500001
});

assert.equal(adattata.ok, true);

// 2. Assemblaggio del ciclo.
const ciclo = componiCicloInCorsa({
  missioni: [adattata.missione],
  trasferimenti: [],
  nodi: adattata.nodi,
  veicoloId: 900001,
  busyStart: BASE,
  busyEnd: BASE + 238000,
  approach: null,
  returnTrip: null,
  postiTotali: 4
});

assert.equal(ciclo.validazioneCapienza.verificata, true);
assert.equal(ciclo.validazioneCapienza.peak, 2);
assert.equal(ciclo.attivabile, false);

// 3. Tratte esterne simulate.
// routingVerificato=true è un fixture sintetico.
// Non costituisce certificazione stradale.
const avvicinamento = {
  routingVerificato: true,
  metres: 5000
};

const ritornoBase = {
  routingVerificato: true,
  metres: 5000
};

// 4. Valutazione economica dell'intero ciclo.
function valutaScenario(nome, prezzo) {
  const risultato = valutaEconomiaCicloFermate({
    ciclo,
    missioni: [alternativa],
    missioniAdattate: [adattata.missione],
    trasferimenti: [],
    richieste: [{
      id: richiestaId,
      prezzo
    }],
    avvicinamento,
    ritornoBase,
    euroKm: 1.50,
    oreAttesa: 0,
    costoAttesaOraEuro: 0,
    altriCostiEuro: 0,
    margineMinimoEuro: 0
  });

  const e = risultato.economia;

  console.log({
    scenario: nome,
    stato: risultato.stato,
    kmMissioni: e.km.missioni,
    kmAvvicinamento: e.km.avvicinamento,
    kmRitorno: e.km.ritornoBase,
    kmTotali: e.km.totali,
    ricavoLordo: e.ricavoLordoEuro,
    commissione: e.commissioneTurentuEuro,
    nettoOperatore: e.ricavoNettoEuro,
    compensoRichiesto: e.costoKmEuro,
    sogliaLorda: e.sogliaAttivazioneLordaEuro,
    margine: e.margineEuro,
    economicamenteAttivabile:
      risultato.economicamenteAttivabile,
    attivabile: risultato.attivabile
  });

  return risultato;
}

// Scenario A: soglia superata.
const sufficiente = valutaScenario(
  'Ricavi sufficienti',
  20
);

assert.equal(sufficiente.ok, true);
assert.equal(sufficiente.economia.km.missioni, 0.869);
assert.equal(sufficiente.economia.km.totali, 10.869);
assert.equal(sufficiente.economia.costoKmEuro, 16.31);
assert.equal(
  sufficiente.economia.sogliaAttivazioneLordaEuro,
  19.19
);
assert.equal(sufficiente.economicamenteAttivabile, true);
assert.equal(
  sufficiente.stato,
  'SOGLIA_ECONOMICA_RAGGIUNTA'
);
assert.equal(sufficiente.attivabile, false);

// Scenario B: soglia non raggiunta.
const insufficiente = valutaScenario(
  'Ricavi insufficienti',
  18
);

assert.equal(insufficiente.ok, true);
assert.equal(insufficiente.economicamenteAttivabile, false);
assert.equal(
  insufficiente.stato,
  'SOGLIA_ECONOMICA_NON_RAGGIUNTA'
);
assert.equal(insufficiente.attivabile, false);

// Controllo di riconciliazione della missione.
assert.equal(
  sufficiente.dettaglioMissioni[0].kmMissione,
  0.869
);

console.log(
  '\nPASS: economia integrata fermate verificata.'
);
