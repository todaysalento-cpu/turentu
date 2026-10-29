
import assert from 'node:assert/strict';

import { rivalidaMissioniFisicheV2 }
  from '../services/popbus/v2/popbus-physical-writer-v2.js';

const BASE = Date.parse('2026-11-01T10:00:00+01:00');

function creaMissione(id = 900001) {
  const partenza = BASE;
  const arrivo = BASE + 188000;

  const itinerario = {
    ok: true,
    routingVerificato: true,
    visite: [
      {
        fermata_id: 14,
        arrivo: partenza,
        partenza: partenza + 50000,
       eventi: [{
  richiesta_id: id,
  tipo: 'salita',
  posti: 2,
  timestampOperazione: partenza
}]
      },
      {
        fermata_id: 15,
        arrivo,
        partenza: arrivo + 50000,
 eventi: [{
  richiesta_id: id,
  tipo: 'discesa',
  posti: 2,
  timestampOperazione: arrivo
}]
      }
    ],
    legs: [{
      metres: 869,
      seconds: 138,
      roadCoincident: false
    }]
  };

  return {
    schemaVersion: 2,
    tipoItinerario: 'FERMATE_FISICHE',
    pixelOpportunitaId: 500001,
    evaluation: {
      requests: [{ id, start: 0, end: 1 }]
    },
    plan: {
      nodes: [14, 15],
      legs: itinerario.legs
    },
    validazioneFisica: { itinerario }
  };
}

const missione = creaMissione();

const richiesta = {
  id: 900001,
  posti_richiesti: 2,
  start_datetime: new Date(BASE).toISOString()
};

const ciclo = {
  missioni: [missione]
};

// TEST 1: missione compatibile.
const positivo = rivalidaMissioniFisicheV2({
  ciclo,
  richiesteBloccate: [richiesta]
});

assert.equal(positivo.ok, true);
assert.equal(positivo.numeroMissioni, 1);
assert.equal(positivo.numeroRichieste, 1);
assert.equal(positivo.attivabile, false);

console.log('PASS 1 - rivalidazione fisica positiva');

// TEST 2: salita fuori tolleranza.
assert.throws(
  () => rivalidaMissioniFisicheV2({
    ciclo,
    richiesteBloccate: [{
      ...richiesta,
      start_datetime: new Date(BASE + 90 * 60000).toISOString()
    }]
  }),
  /compatibilita temporale fallita/
);

console.log('PASS 2 - orario modificato rifiutato');

// TEST 3: richiesta non bloccata.
assert.throws(
  () => rivalidaMissioniFisicheV2({
    ciclo,
    richiesteBloccate: [{
      ...richiesta,
      id: 900002
    }]
  }),
  /richiesta non bloccata/
);

console.log('PASS 3 - richiesta non bloccata rifiutata');

// TEST 4: richiesta duplicata fra missioni.
assert.throws(
  () => rivalidaMissioniFisicheV2({
    ciclo: {
      missioni: [
        creaMissione(900001),
        creaMissione(900001)
      ]
    },
    richiesteBloccate: [richiesta]
  }),
  /richiesta duplicata nel ciclo/
);

console.log('PASS 4 - richiesta duplicata rifiutata');


// TEST 5: il piano non può usare fermate differenti.
assert.throws(
  () => rivalidaMissioniFisicheV2({
    ciclo: {
      missioni: [{
        ...missione,
        plan: {
          ...missione.plan,
          nodes: [14, 16]
        }
      }]
    },
    richiesteBloccate: [richiesta]
  }),
  /fermata fisica discordante/
);

console.log('PASS 5 - fermata discordante rifiutata');

// TEST 6: il piano non può alterare le percorrenze.
assert.throws(
  () => rivalidaMissioniFisicheV2({
    ciclo: {
      missioni: [{
        ...missione,
        plan: {
          ...missione.plan,
          legs: [{
            ...missione.plan.legs[0],
            metres: 9999
          }]
        }
      }]
    },
    richiesteBloccate: [richiesta]
  }),
  /segmento fisico discordante/
);

console.log('PASS 6 - segmento discordante rifiutato');


console.log(
  'RISULTATO: 6/6 test rivalidazione fisica V2 superati'
);