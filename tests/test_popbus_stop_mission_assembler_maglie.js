
import assert from 'node:assert/strict';

import { adattaMissioneFermate }
  from '../services/popbus/v2/popbus-stop-mission-adapter.service.js';

import { componiCicloInCorsa }
  from '../services/popbus/v2/popbus-single-corsa-assembler.js';

const BASE = Date.parse('2026-11-01T10:00:00+01:00');

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

const richieste = [
  { id: 900001, posti_richiesti: 2 }
];

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
          richiesta_id: 900001,
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
          richiesta_id: 900001,
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

console.log('=== POPBUS V2 - STOP MISSION -> ASSEMBLER ===');

const adattata = adattaMissioneFermate({
  alternativa,
  richieste,
  corridorId: 500001
});

assert.equal(adattata.ok, true);
assert.equal(adattata.diagnostica.soste, 2);
assert.equal(adattata.diagnostica.segmenti, 3);
assert.deepEqual(adattata.missione.nodes, [14, 14, 15, 15]);

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

assert.equal(ciclo.tipoPiano, 'CICLO_PIXEL_CORSA_UNICA_V1');
assert.equal(ciclo.validazioneCapienza.verificata, true);
assert.equal(ciclo.validazioneCapienza.peak, 2);
assert.equal(ciclo.legs.length, 3);
assert.equal(ciclo.evaluation.times.at(-1), 238000);

const metri = ciclo.legs.reduce(
  (tot, leg) => tot + leg.metres, 0
);

assert.equal(metri, 869);
assert.equal(ciclo.attivabile, false);

console.log({
  nodes: ciclo.nodes,
  metriTotaliMissione: metri,
  secondiTotali: ciclo.evaluation.times.at(-1) / 1000,
  soste: ciclo.legs.filter(l => l.attesa).length,
  peak: ciclo.validazioneCapienza.peak,
  capienzaVerificata: ciclo.validazioneCapienza.verificata,
  attivabile: ciclo.attivabile
});

console.log('\nPASS: adapter e assembler compatibili.');
