
// tests/test_popbus_pixel_intermediate_stops_shadow.js
import assert from 'node:assert/strict';

import { generaAlternativeFisichePixelShadow } from
  '../services/popbus/v2/popbus-pixel-stop-bridge.service.js';

const T = Date.parse('2026-11-01T14:00:00+01:00');

const MIN = 60_000;
const ISO = ms => new Date(ms).toISOString();

const fermate = {
  tricase: {
    fermata_id: 101,
    nome: 'Tricase',
    lat: 39.9300,
    lon: 18.3600,
    nodo_territoriale_id: 5
  },
  maglie: {
    fermata_id: 102,
    nome: 'Maglie',
    lat: 40.1200,
    lon: 18.3000,
    nodo_territoriale_id: 6
  },
  lecce: {
    fermata_id: 103,
    nome: 'Lecce',
    lat: 40.3500,
    lon: 18.1700,
    nodo_territoriale_id: 7
  }
};

const candidato = (stop, distanza_metri = 50) => ({
  ...stop,
  distanza_metri,
  verificata: false,
  tipi_veicolo_ammessi: ['ncc']
});

const richieste = [
  {
    id: 900101,
    posti_richiesti: 2,
    start_datetime: ISO(T),
    prezzo: 14,
    tempo_diretto_secondi: 4200,
    max_ritardo_minuti: 30
  },
  {
    id: 900102,
    posti_richiesti: 2,
    start_datetime: ISO(T + 30 * MIN),
    prezzo: 9,
    tempo_diretto_secondi: 2400,
    max_ritardo_minuti: 30
  },
  {
    id: 900103,
    posti_richiesti: 1,
    start_datetime: ISO(T),
    prezzo: 7,
    tempo_diretto_secondi: 1800,
    max_ritardo_minuti: 30
  }
];

const formazione = {
  pixelOpportunitaId: 401,
  pixelDirettriceId: 402,
  pixelVersione: 3,
  nodiTerritoriali: [5, 6, 7],
  corridoioPixelId: 'territorial:5>6>7',
  departure: T,
  evaluation: {
    requests: [
      { id: 900101, start: 0, end: 2, posti_richiesti: 2 },
      { id: 900102, start: 1, end: 2, posti_richiesti: 2 },
      { id: 900103, start: 0, end: 1, posti_richiesti: 1 }
    ]
  }
};

const candidati = [
  {
    richiesta_id: 900101,
    salita: [candidato(fermate.tricase)],
    discesa: [candidato(fermate.lecce)]
  },
  {
    richiesta_id: 900102,
    salita: [candidato(fermate.maglie)],
    discesa: [candidato(fermate.lecce)]
  },
  {
    richiesta_id: 900103,
    salita: [candidato(fermate.tricase)],
    discesa: [candidato(fermate.maglie)]
  }
];

let queryCount = 0;
let routingCount = 0;

const client = {
  query: async () => {
    queryCount++;
    throw new Error('QUERY_DB_VIETATA');
  }
};

// Tempi sintetici, non misure stradali reali.
// Tricase -> Maglie: 29 minuti.
// Maglie -> Lecce: 39 minuti.
const segmenti = new Map([
  ['101>102', { metres: 25000, seconds: 1740 }],
  ['102>103', { metres: 35000, seconds: 2340 }]
]);

const routing = async (from, to) => {
  routingCount++;

  const key = `${from.fermata_id}>${to.fermata_id}`;
  const segmento = segmenti.get(key);

  assert.ok(segmento, `Routing inatteso: ${key}`);

  return {
    ...segmento,
    polyline: '_p~iF~ps|U_ulLnnqC_mqNvxq`@'
  };
};

const servizi = {
  cercaFermateCandidate: async ({ richiestaIds }) => {
    assert.deepEqual(
      [...richiestaIds].sort((a, b) => a - b),
      [900101, 900102, 900103]
    );
    return candidati;
  }
};

const run = (inputRichieste = richieste, postiTotali = 4) =>
  generaAlternativeFisichePixelShadow({
    client,
    formazione,
    richieste: inputRichieste,
    postiTotali,
    tipoVeicolo: 'ncc',
    routing,
    servizi,
    maxCombinazioni: 10,
    maxValutazioni: 10
  });

let passed = 0;

async function test(nome, fn) {
  await fn();
  passed++;
  console.log(`PASS - ${nome}`);
}

function getAlternativa(r) {
  assert.equal(r.ok, true);
  assert.equal(
    r.alternativeFisiche.length,
    1,
    JSON.stringify(r.diagnostica)
  );
  return r.alternativeFisiche[0];
}

await test('tre richieste nella stessa missione', async () => {
  const r = await run();
  const a = getAlternativa(r);

  assert.equal(a.alternativa.sequenza.visite.length, 3);
  assert.deepEqual(
    a.alternativa.sequenza.visite.map(v => v.fermata_id),
    [101, 102, 103]
  );
});

await test('Maglie: una visita, discesa e salita', async () => {
  const a = getAlternativa(await run());
  const visite = a.alternativa.itinerario.visite;

  assert.equal(visite.length, 3);

  const maglie = visite[1];

  assert.equal(maglie.fermata_id, 102);
  assert.equal(maglie.eventi.length, 2);

  assert.deepEqual(
    maglie.eventi
      .map(e => `${e.tipo}:${e.richiesta_id}`)
      .sort(),
    ['discesa:900103', 'salita:900102']
  );

  assert.equal(maglie.sostaSecondi, 60);
});

await test('capienza: picco quattro posti', async () => {
  const a = getAlternativa(await run());

  assert.equal(a.alternativa.sequenza.peak, 4);
  assert.equal(a.alternativa.itinerario.peak, 4);
  assert.equal(
    a.alternativa.itinerario.capienzaVerificata,
    true
  );
});

await test('orari di salita alle fermate effettive', async () => {
  const a = getAlternativa(await run());

  const temporale = a.alternativa.temporale;

  assert.equal(temporale.ok, true);
  assert.equal(temporale.dettagli.length, 3);

  const byId = new Map(
    temporale.dettagli.map(d => [d.richiestaId, d])
  );

  assert.equal(byId.get(900101).fermataId, 101);
  assert.equal(byId.get(900102).fermataId, 102);
  assert.equal(byId.get(900103).fermataId, 101);

  for (const d of temporale.dettagli) {
    assert.equal(d.compatibile, true);
  }
});

await test('qualita individuale e parametri espliciti', async () => {
  const a = getAlternativa(await run());

  for (const r of richieste) {
    assert.ok(r.tempo_diretto_secondi > 0);
    assert.ok(r.max_ritardo_minuti >= 0);
  }

  assert.equal(a.alternativa.qualita.ok, true);
});

await test('capienza insufficiente: nessuna alternativa', async () => {
  const r = await run(richieste, 3);

  assert.equal(r.ok, true);
  assert.equal(r.alternativeFisiche.length, 0);
  assert.ok(r.diagnostica.valutazione.scartate > 0);
});

await test('nessuna query DB e nessuna attivazione', async () => {
  const r = await run();
  const a = getAlternativa(r);

  assert.equal(queryCount, 0);
  assert.ok(routingCount > 0);
  assert.equal(r.attivabile, false);
  assert.equal(a.attivabile, false);
});

console.log(
  `RISULTATO: ${passed} PASS, 0 FAIL; DB ${queryCount} query; LIVE NO.`
);
