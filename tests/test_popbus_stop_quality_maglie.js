
import assert from 'node:assert/strict';

import { verificaQualitaFermate }
  from '../services/popbus/v2/popbus-stop-quality.service.js';

const BASE = Date.parse('2026-11-01T10:00:00+01:00');

const itinerario = {
  ok: true,
  visite: [
    {
      fermata_id: 14,
      arrivo: BASE,
      partenza: BASE + 50000,
      eventi: [
        { tipo: 'salita', richiesta_id: 900001, posti: 2 }
      ]
    },
    {
      fermata_id: 15,
      arrivo: BASE + 188000,
      partenza: BASE + 238000,
      eventi: [
        { tipo: 'discesa', richiesta_id: 900001, posti: 2 }
      ]
    }
  ],
  legs: [
    { metres: 869, seconds: 138, roadCoincident: false }
  ]
};

function richiesta(overrides = {}) {
  return {
    id: 900001,
    distanza_diretta_km: 0.869,
    tempo_diretto_secondi: 138,
    max_deviazione_pct: 20,
    max_ritardo_minuti: 5,
    max_fermate_intermedie: 0,
    min_km_tra_fermate: 0,
    ...overrides
  };
}

function test(nome, dati, atteso, motivoAtteso = null) {
  const risultato = verificaQualitaFermate({
    itinerario,
    richieste: [richiesta(dati)]
  });

  assert.equal(risultato.ok, atteso, nome);

  if (motivoAtteso) {
    assert.equal(risultato.motivo, motivoAtteso, nome);
  }

  console.log({
    test: nome,
    conforme: risultato.ok,
    motivo: risultato.motivo ?? null,
    stato: risultato.stato
  });
}

console.log('=== POPBUS V2 - QUALITA FERMATE MAGLIE ===');

// Percorso e durata diretti: nessuna deviazione.
test('Percorso conforme', {}, true);

// 869 m contro 500 m diretti: deviazione del 73,8%.
test(
  'Deviazione eccessiva',
  { distanza_diretta_km: 0.5 },
  false,
  'DEVIAZIONE_ECCESSIVA'
);

// Il percorso richiede 138 secondi,
// ma il limite dichiarato e' 60 secondi.
test(
  'Ritardo stradale eccessivo',
  {
    tempo_diretto_secondi: 60,
    max_ritardo_minuti: 0
  },
  false,
  'RITARDO_ECCESSIVO'
);

console.log('\nPASS: controlli qualita verificati.');
