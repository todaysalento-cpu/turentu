import { valutaEconomiaCicloFermate } from '../services/popbus/v2/popbus-stop-cycle-economics-adapter.service.js';
import { adattaMissioneFermate } from '../services/popbus/v2/popbus-stop-mission-adapter.service.js';
import { componiCicloInCorsa } from '../services/popbus/v2/popbus-single-corsa-assembler.js';

const t = Date.parse('2027-04-01T08:00:00Z');

function alternativa(visite, legs, departure, fineOperazioni) {
  return {
    sequenza: { ok: true },
    temporale: { ok: true },
    qualita: { ok: true },
    itinerario: {
      ok: true,
      routingVerificato: true,
      departure,
      fineOperazioni,
      visite,
      legs
    }
  };
}

function visita(fermata_id, lat, lon, arrivo, sostaSecondi, eventi) {
  return {
    fermata_id,
    lat,
    lon,
    arrivo,
    partenza: arrivo + sostaSecondi * 1000,
    sostaSecondi,
    eventi: eventi.map(e => ({
      ...e,
      timestampOperazione: arrivo
    }))
  };
}

// Missione 1: quattro passeggeri trasportati,
// con occupazione massima di due posti.
const visite1 = [
  visita(101, 40.1, 18.1, t, 50, [
    { richiesta_id: 1, tipo: 'salita', posti: 2 }
  ]),
  visita(102, 40.2, 18.2, t + 170000, 60, [
    { richiesta_id: 1, tipo: 'discesa', posti: 2 },
    { richiesta_id: 2, tipo: 'salita', posti: 2 }
  ]),
  visita(103, 40.3, 18.3, t + 350000, 40, [
    { richiesta_id: 2, tipo: 'discesa', posti: 2 }
  ])
];

const m1 = adattaMissioneFermate({
  alternativa: alternativa(
    visite1,
    [
      { metres: 6000, seconds: 120, polyline: 'abc' },
      { metres: 6000, seconds: 120, polyline: 'def' }
    ],
    t,
    t + 390000
  ),
  richieste: [
    { id: 1, posti_richiesti: 2 },
    { id: 2, posti_richiesti: 2 }
  ],
  corridorId: 900
});

// Missione 2: inizia 8 minuti dopo la fine della prima.
// 5 minuti di trasferimento + 3 minuti di attesa.
const t2 = t + 870000;

const visite2 = [
  visita(201, 40.4, 18.4, t2, 40, [
    { richiesta_id: 3, tipo: 'salita', posti: 2 }
  ]),
  visita(202, 40.5, 18.5, t2 + 160000, 50, [
    { richiesta_id: 3, tipo: 'discesa', posti: 2 }
  ])
];

const m2 = adattaMissioneFermate({
  alternativa: alternativa(
    visite2,
    [{ metres: 5000, seconds: 120, polyline: 'ghi' }],
    t2,
    t2 + 210000
  ),
  richieste: [
    { id: 3, posti_richiesti: 2 }
  ],
  corridorId: 901
});

const nodi = [...m1.nodi, ...m2.nodi];

const trasferimenti = [{
  seconds: 300,
  metres: 4000,
  polyline: 'transfer',
  attesaMinuti: 3
}];

const ciclo = componiCicloInCorsa({
  missioni: [m1.missione, m2.missione],
  trasferimenti,
  nodi,
  veicoloId: 10,
  busyStart: new Date(t - 600000).toISOString(),
  busyEnd: new Date(t + 1800000).toISOString(),
  approach: { metres: 8000 },
  returnTrip: { metres: 10000 },
  postiTotali: 2
});

const risultato = {
  tipoPiano: ciclo.tipoPiano,
  missioni: ciclo.missioni.length,
  nodiOperativi: ciclo.nodes,
  segmenti: ciclo.legs.length,
  durataSecondi:
    (ciclo.evaluation.arrival - ciclo.evaluation.departure) / 1000,
  richieste: ciclo.evaluation.requests,
  peak: ciclo.evaluation.peak,
  capienza: ciclo.validazioneCapienza,
  attivabile: ciclo.attivabile
};

console.log(JSON.stringify(risultato, null, 2));

const assert = (condizione, messaggio) => {
  if (!condizione) throw new Error(`TEST FALLITO: ${messaggio}`);
};

assert(risultato.missioni === 2, 'numero missioni');
assert(risultato.durataSecondi === 1080, 'durata ciclo');
assert(risultato.peak === 2, 'occupazione massima');
assert(risultato.capienza.verificata === true, 'capienza');
assert(risultato.capienza.totalePasseggeri === 6, 'passeggeri');
assert(risultato.richieste.length === 3, 'numero richieste');
assert(risultato.attivabile === false, 'sicurezza attivazione');

console.log('TEST MULTI-MISSIONE SUPERATO');
const economiaIntegrata = valutaEconomiaCicloFermate({
  ciclo,
  missioniAdattate: [m1.missione, m2.missione],
  missioni: [
    m1 && {
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
    m2 && {
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
  ],
  trasferimenti: [
    { metres: 4000, routingVerificato: true }
  ],
  richieste: [
    { id: 1, prezzo: 35 },
    { id: 2, prezzo: 25 },
    { id: 3, prezzo: 20 }
  ],
  avvicinamento: {
    metres: 8000,
    routingVerificato: true
  },
  ritornoBase: {
    metres: 10000,
    routingVerificato: true
  },
  euroKm: 1.5
});

assert(
  economiaIntegrata.economia.km.totali === 39,
  'chilometri economici'
);
assert(
  economiaIntegrata.economia.margineEuro === 9.5,
  'margine economico'
);
assert(
  economiaIntegrata.attivabile === false,
  'attivazione economica'
);

console.log('TEST ASSEMBLER + ECONOMICS SUPERATO');
