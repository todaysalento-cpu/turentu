
import assert from 'node:assert/strict';

import { generaCicliDueMissioniShadow }
  from '../services/popbus/v2/pixel-multimission-shadow.js';

import { adattaMissioneFermate }
  from '../services/popbus/v2/popbus-stop-mission-adapter.service.js';

import { componiCicloInCorsa }
  from '../services/popbus/v2/popbus-single-corsa-assembler.js';

import { valutaEconomiaCicloFermate }
  from '../services/popbus/v2/popbus-stop-cycle-economics-adapter.service.js';

const BASE = Date.parse('2026-11-01T10:00:00+01:00');
const MIN = 60000;

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

const veicolo = {
  id: 900001,
  lat: 40.11,
  lon: 18.31,
  euroKm: 1.50,
  posti_totali: 4
};

const richieste = [
  { id: 900001, posti_richiesti: 2, prezzo: 11 },
  { id: 900002, posti_richiesti: 2, prezzo: 11 }
];

function creaAlternativa({
  from, to, departure, roadMetres, roadSeconds, id
}) {
  const arrivoSeconda = departure + (50 + roadSeconds) * 1000;
  const fine = arrivoSeconda + 50000;

  return {
    sequenza: { ok: true },
    temporale: { ok: true },
    qualita: { ok: true },
    itinerario: {
      ok: true,
      routingVerificato: true,
      departure,
      fineOperazioni: fine,
      visite: [
        {
          ...from,
          arrivo: departure,
          partenza: departure + 50000,
          sostaSecondi: 50,
          eventi: [{
            richiesta_id: id,
            tipo: 'salita',
            posti: 2,
            timestampOperazione: departure
          }]
        },
        {
          ...to,
          arrivo: arrivoSeconda,
          partenza: fine,
          sostaSecondi: 50,
          eventi: [{
            richiesta_id: id,
            tipo: 'discesa',
            posti: 2,
            timestampOperazione: arrivoSeconda
          }]
        }
      ],
      legs: [{
        metres: roadMetres,
        seconds: roadSeconds,
        polyline: `fixture-${from.fermata_id}-${to.fermata_id}`
      }]
    }
  };
}

const alternative = [
  creaAlternativa({
    from: f14,
    to: f15,
    departure: BASE,
    roadMetres: 869,
    roadSeconds: 138,
    id: 900001
  }),
  creaAlternativa({
    from: f15,
    to: f14,
    departure: BASE + 15 * MIN,
    roadMetres: 882,
    roadSeconds: 139,
    id: 900002
  })
];

console.log(
  '=== POPBUS V2 - DUE MISSIONI FISICHE SHADOW ==='
);

// FASE 1: adattamento delle missioni.
const adattate = alternative.map((alternativa, i) =>
  adattaMissioneFermate({
    alternativa,
    richieste: [richieste[i]],
    corridorId: 500001 + i
  })
);

for (const a of adattate) {
  assert.equal(a.ok, true);
  assert.equal(a.diagnostica.soste, 2);
  assert.equal(a.missione.nodes.length, 4);
}

const candidate = adattate.map((a, i) => {
  const m = a.missione;
  const alt = alternative[i];

  return {
    pixelOpportunitaId: 500001 + i,
    from: {
      lat: alt.itinerario.visite[0].lat,
      lon: alt.itinerario.visite[0].lon
    },
    to: {
      lat: alt.itinerario.visite[1].lat,
      lon: alt.itinerario.visite[1].lon
    },
    departure: m.departure,
    arrival: m.arrival,
    kmMissione:
      m.legs.reduce((s, l) => s + Number(l.metres), 0) / 1000,
    requests: [{
      id: richieste[i].id,
      prezzo: richieste[i].prezzo
    }],
    peak: 2
  };
});

// FASE 2: routing tecnico sintetico.
const stessoPunto = (a, b) =>
  Number(a.lat) === Number(b.lat) &&
  Number(a.lon) === Number(b.lon);

async function movement(a, b) {
  if (stessoPunto(a, b)) {
    return { metres: 0, seconds: 0 };
  }

  // Fixture: avvicinamento e ritorno alla base.
  return { metres: 5000, seconds: 600 };
}

const shadow = await generaCicliDueMissioniShadow({
  missions: candidate,
  vehicles: [veicolo],
  movement,
  isAvailable: async () => true,
  hasConflicts: async () => false,
  now: BASE - 60 * MIN,
  maxPairs: 10,
  maxRoutingCalls: 10,
  costoAttesaOraEuro: 0
});

assert.equal(shadow.shadow, true);
assert.equal(shadow.dbWrites, 0);
assert.equal(shadow.cicli.length, 1);

const selezionato = shadow.cicli[0];

assert.deepEqual(
  selezionato.richieste,
  [900001, 900002]
);

assert.equal(selezionato._shadow.transfer.metres, 0);
assert.equal(selezionato._shadow.transfer.seconds, 0);

const attesaSecondi =
  (candidate[1].departure - candidate[0].arrival) / 1000;

assert.equal(attesaSecondi, 662);

// FASE 3: assemblaggio.
const nodiMap = new Map();

for (const a of adattate) {
  for (const n of a.nodi) {
    nodiMap.set(Number(n.id), n);
  }
}

const approach = {
  ...selezionato._shadow.approach,
  routingVerificato: true
};

const returnTrip = {
  ...selezionato._shadow.returnTrip,
  routingVerificato: true
};

const transfer = {
  ...selezionato._shadow.transfer,
  routingVerificato: true
};

const ciclo = componiCicloInCorsa({
  missioni: adattate.map(a => a.missione),
  trasferimenti: [{
    ...transfer,
    attesaMinuti: attesaSecondi / 60
  }],
  nodi: [...nodiMap.values()],
  veicoloId: veicolo.id,
  busyStart: selezionato.partenza_base,
  busyEnd: selezionato.ritorno_base,
  approach,
  returnTrip,
  postiTotali: veicolo.posti_totali
});

assert.equal(ciclo.missioni.length, 2);
assert.equal(ciclo.validazioneCapienza.verificata, true);
assert.equal(ciclo.validazioneCapienza.peak, 2);
assert.equal(ciclo.validazioneCapienza.totalePasseggeri, 4);
assert.equal(ciclo.attivabile, false);

assert.deepEqual(
  ciclo.evaluation.requests.map(r => r.id),
  [900001, 900002]
);

const metriMissioni =
  adattate.reduce(
    (tot, a) =>
      tot + a.missione.legs.reduce(
        (s, l) => s + Number(l.metres), 0
      ),
    0
  );

assert.equal(metriMissioni, 1751);

const attese = ciclo.legs.filter(l => l.attesa === true);

assert.equal(
  attese.reduce((s, l) => s + Number(l.seconds), 0),
  862
);

// 200 secondi di soste nelle missioni + 662 di attesa.
assert.equal(
  ciclo.evaluation.arrival - ciclo.evaluation.departure,
  1139000
);

// FASE 4: economia completa.
const economica = valutaEconomiaCicloFermate({
  ciclo,
  missioni: alternative,
  missioniAdattate: adattate.map(a => a.missione),
  trasferimenti: [transfer],
  richieste,
  avvicinamento: approach,
  ritornoBase: returnTrip,
  euroKm: veicolo.euroKm,
  oreAttesa: selezionato._shadow.waitingHours,
  costoAttesaOraEuro: 0,
  altriCostiEuro: 0,
  margineMinimoEuro: 0
});

assert.equal(economica.ok, true);
assert.equal(economica.dettaglioMissioni.length, 2);
assert.equal(economica.economia.km.missioni, 1.751);
assert.equal(economica.economia.km.trasferimenti, 0);
assert.equal(economica.economia.km.avvicinamento, 5);
assert.equal(economica.economia.km.ritornoBase, 5);
assert.equal(economica.economia.km.totali, 11.751);
assert.equal(economica.economia.ricavoLordoEuro, 22);
assert.equal(economica.economicamenteAttivabile, true);
assert.equal(economica.attivabile, false);

// Confronto tra economia SHADOW e adapter finale.
assert.equal(
  economica.economia.centesimi.costoCompleto,
  selezionato._shadow.economia.centesimi.costoCompleto
);

assert.equal(
  economica.economia.centesimi.ricavoLordo,
  selezionato._shadow.economia.centesimi.ricavoLordo
);

console.log({
  missioni: ciclo.missioni.length,
  richieste: ciclo.evaluation.requests.map(r => r.id),
  passeggeriTotali: ciclo.validazioneCapienza.totalePasseggeri,
  peak: ciclo.validazioneCapienza.peak,
  metriMissioni,
  attesaTraMissioniSecondi: attesaSecondi,
  kmCicloOperativo: economica.economia.km.totali,
  ricavoLordo: economica.economia.ricavoLordoEuro,
  compensoNCC: economica.economia.costoKmEuro,
  margine: economica.economia.margineEuro,
  economicamenteAttivabile:
    economica.economicamenteAttivabile,
  attivabile: economica.attivabile,
  dbWrites: shadow.dbWrites
});

console.log(
  '\nPASS: SHADOW -> Adapter -> Assembler -> Economia.'
);
