
import assert from 'node:assert/strict';

import { valutaEconomiaCicloFermate } from '../services/popbus/v2/popbus-stop-cycle-economics-adapter.service.js';

// Ciclo simulato equivalente al test multi-missione precedente.
// Non certifica routing reale o validazioni operative.
const richieste = [
  { id: 1, prezzo: 35 },
  { id: 2, prezzo: 25 },
  { id: 3, prezzo: 20 }
];

const missioni = [
  {
    sequenza: { ok: true },
    temporale: { ok: true },
    qualita: { ok: true },
    itinerario: {
      ok: true,
      routingVerificato: true,
      legs: [
        { metres: 6000, seconds: 120, polyline: 'abc' },
        { metres: 6000, seconds: 120, polyline: 'def' }
      ]
    }
  },
  {
    sequenza: { ok: true },
    temporale: { ok: true },
    qualita: { ok: true },
    itinerario: {
      ok: true,
      routingVerificato: true,
      legs: [
        { metres: 5000, seconds: 120, polyline: 'ghi' }
      ]
    }
  }
];

const ciclo = {
  attivabile: false,
  validazioneCapienza: {
    verificata: true,
    peak: 2,
    postiTotali: 2
  },
  evaluation: {
    requests: [
      { id: 1, start: 0, end: 2, posti_richiesti: 2 },
      { id: 2, start: 2, end: 4, posti_richiesti: 2 },
      { id: 3, start: 7, end: 9, posti_richiesti: 2 }
    ]
  },
  missioni: [
    { richieste: [1, 2] },
    { richieste: [3] }
  ],
  legs: [
    { metres: 0, seconds: 50, polyline: 's1' },
    { metres: 6000, seconds: 120, polyline: 'abc' },
    { metres: 0, seconds: 60, polyline: 's2' },
    { metres: 6000, seconds: 120, polyline: 'def' },
    { metres: 0, seconds: 40, polyline: 's3' },
    { metres: 4000, seconds: 300, polyline: 'transfer' },
    { metres: 0, seconds: 180, polyline: 'wait' },
    { metres: 0, seconds: 40, polyline: 's4' },
    { metres: 5000, seconds: 120, polyline: 'ghi' },
    { metres: 0, seconds: 50, polyline: 's5' }
  ]
};

const parametri = {
  ciclo,
  missioni,
  trasferimenti: [
    { metres: 4000, routingVerificato: true }
  ],
  richieste,
  avvicinamento: {
    metres: 8000,
    routingVerificato: true
  },
  ritornoBase: {
    metres: 10000,
    routingVerificato: true
  },
  euroKm: 1.5
};

const risultato = valutaEconomiaCicloFermate(parametri);

assert.equal(risultato.ok, true);
assert.equal(risultato.economia.km.totali, 39);
assert.equal(risultato.economia.ricavoLordoEuro, 80);
assert.equal(risultato.economia.commissioneTurentuEuro, 12);
assert.equal(risultato.economia.margineEuro, 9.5);
assert.equal(risultato.economicamenteAttivabile, true);
assert.equal(risultato.attivabile, false);
assert.deepEqual(risultato.richiesteValutate, [1, 2, 3]);

console.log(JSON.stringify({
  stato: risultato.stato,
  richieste: risultato.richiesteValutate,
  km: risultato.economia.km,
  ricavoLordo: risultato.economia.ricavoLordoEuro,
  commissione: risultato.economia.commissioneTurentuEuro,
  margine: risultato.economia.margineEuro,
  economicamenteAttivabile: risultato.economicamenteAttivabile,
  attivabile: risultato.attivabile
}, null, 2));

console.log('TEST STOP CYCLE ECONOMICS SUPERATO');
