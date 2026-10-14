
import {
  valutaRichieste,
  generaFormazioniAlternative
} from '../services/popbus/v2/model.js';

// Correggere il percorso import se necessario.

const partenza = '2026-10-20T08:00:00Z';

const plan = {
  nodes: [1, 3, 4],
  classe: 'STANDARD',
  legs: [
    { metres: 10000, seconds: 600 },
    { metres: 10000, seconds: 600 }
  ]
};

const requests = [
  {
    id: 1001,
    start_node_id: 1,
    end_node_id: 3,
    start_datetime: partenza,
    posti_richiesti: 4,
    prezzo: 40,
    classe: 'STANDARD'
  },
  {
    id: 1002,
    start_node_id: 1,
    end_node_id: 4,
    start_datetime: partenza,
    posti_richiesti: 5,
    prezzo: 50,
    classe: 'STANDARD'
  },
  {
    id: 1003,
    start_node_id: 3,
    end_node_id: 4,
    start_datetime: '2026-10-20T08:10:00Z',
    posti_richiesti: 3,
    prezzo: 30,
    classe: 'STANDARD'
  }
];

const result = valutaRichieste(
  plan,
  requests,
  [1001, 1002, 1003],
  { mode: 'seeds_only', maxPeak: 10 }
);

console.log('RISULTATO MATCHING:', result);

if (!result) {
  throw new Error('Matching multi-segmento fallito');
}

if (JSON.stringify(result.occupancy) !== '[9,8]') {
  throw new Error(
    `Occupazione errata: ${result.occupancy}`
  );
}

if (result.peak !== 9) {
  throw new Error(`Picco errato: ${result.peak}`);
}

if (result.requests.length !== 3) {
  throw new Error('Non tutte le richieste sono incluse');
}

const alternatives = generaFormazioniAlternative(
  plan,
  requests,
  [1001],
  { maxFormazioni: 80 }
);

console.log(
  'FORMAZIONI ALTERNATIVE:',
  alternatives.map(a => ({
    richieste: a.requests.map(r => r.id),
    occupazione: a.occupancy,
    picco: a.peak,
    ricavo: a.revenue
  }))
);

console.log('TEST MULTI-SEGMENTO SUPERATO');
