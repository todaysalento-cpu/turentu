
import assert from 'node:assert/strict';

import { valutaCombinazioniFermate }
  from '../services/popbus/v2/popbus-stop-evaluator.service.js';

import { TOLLERANZA_MS }
  from '../services/popbus/v2/model.js';

const BASE = Date.parse('2026-11-01T10:00:00+01:00');

const fermate = {
  14: { fermata_id: 14, lat: 40.121583, lon: 18.305914 },
  15: {
    fermata_id: 15,
    lat: 40.1258486502909,
    lon: 18.299920672780097
  },
  16: { fermata_id: 16, lat: 40.13, lon: 18.31 }
};

const richieste = [
  {
    id: 900001,
    posti_richiesti: 1,
    start_datetime: new Date(BASE).toISOString(),
    distanza_diretta_km: 1,
    tempo_diretto_secondi: 2400,
    max_deviazione_pct: 100,
    max_ritardo_minuti: 60,
    max_fermate_intermedie: 2,
    min_km_tra_fermate: 0
  },
  {
    id: 900002,
    posti_richiesti: 1,
    start_datetime: new Date(BASE).toISOString(),
    distanza_diretta_km: 1,
    tempo_diretto_secondi: 2400,
    max_deviazione_pct: 100,
    max_ritardo_minuti: 60,
    max_fermate_intermedie: 2,
    min_km_tra_fermate: 0
  }
];

function assegnazione(id, salita, discesa, start, end) {
  return {
    richiesta_id: id,
    start_territoriale: start,
    end_territoriale: end,
    posti_richiesti: 1,
    salita: fermate[salita],
    discesa: fermate[discesa]
  };
}

const combinazioni = [
  {
    scorePreliminare: 1,
    assegnazioni: [
      assegnazione(900001, 14, 16, 0, 2),
      assegnazione(900002, 15, 16, 1, 2)
    ]
  },
  {
    scorePreliminare: 2,
    assegnazioni: [
      assegnazione(900001, 14, 16, 0, 2),
      assegnazione(900002, 15, 16, 1, 2)
    ]
  }
];

// Durata diversa per combinazione, simulando
// due alternative stradali sullo stesso ordine di fermate.
// Il valutatore riceve un unico callback routing:
// differenziamo i due tentativi in modo deterministico.
let tentativo = 0;

async function routingSimulato(a, b) {
  if (Number(a.fermata_id) === 14 &&
      Number(b.fermata_id) === 15) {
    tentativo++;

    return {
      metres: tentativo === 1 ? 2000 : 500,
      seconds: tentativo === 1
        ? TOLLERANZA_MS / 1000 + 60
        : 300,
      polyline: 'test-polyline'
    };
  }

  if (Number(a.fermata_id) === 15 &&
      Number(b.fermata_id) === 16) {
    return {
      metres: 500,
      seconds: 300,
      polyline: 'test-polyline'
    };
  }

  throw new Error(
    `Segmento inatteso: ${a.fermata_id} -> ${b.fermata_id}`
  );
}

async function main() {
  console.log('=== POPBUS V2 - FALLBACK TEMPORALE ===');

  const risultato = await valutaCombinazioniFermate({
    combinazioni,
    richieste,
    postiTotali: 4,
    departure: BASE,
    routing: routingSimulato
  });

  console.table(risultato.scartate);
  console.table(
    risultato.valide.map(v => ({
      indice: v.indice,
      kmMissione: v.kmMissione,
      stato: v.stato
    }))
  );

  assert.equal(risultato.scartate.length, 1);
  assert.equal(risultato.scartate[0].indice, 0);
  assert.equal(risultato.scartate[0].fase, 'TEMPORALE');
  assert.equal(
    risultato.scartate[0].motivo,
    'SALITA_FUORI_TOLLERANZA'
  );
  assert.equal(risultato.scartate[0].richiestaId, 900002);

  assert.equal(risultato.valide.length, 1);
  assert.equal(risultato.valide[0].indice, 1);
  assert.equal(risultato.valide[0].attivabile, false);

  console.log('\nPASS: fallback temporale verificato.');
}

main().catch(error => {
  console.error('FAIL:', error);
  process.exitCode = 1;
});
