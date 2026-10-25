
import assert from 'node:assert/strict';

import { verificaQualitaFermate }
  from '../services/popbus/v2/popbus-stop-quality.service.js';

const BASE = Date.parse('2026-11-01T10:00:00+01:00');

function creaItinerario(sostaIntermediaSecondi) {
  const partenza14 = BASE + 30_000;
  const arrivoIntermedio = partenza14 + 60_000;
  const partenzaIntermedio =
    arrivoIntermedio + sostaIntermediaSecondi * 1000;
  const arrivo15 = partenzaIntermedio + 78_000;

  return {
    ok: true,
    visite: [
      {
        fermata_id: 14,
        arrivo: BASE,
        partenza: partenza14,
        eventi: [
          { tipo: 'salita', richiesta_id: 900001, posti: 1 }
        ]
      },
      {
        fermata_id: 16,
        arrivo: arrivoIntermedio,
        partenza: partenzaIntermedio,
        eventi: [
          { tipo: 'salita', richiesta_id: 900002, posti: 1 }
        ]
      },
      {
        fermata_id: 15,
        arrivo: arrivo15,
        partenza: arrivo15 + 30_000,
        eventi: [
          { tipo: 'discesa', richiesta_id: 900001, posti: 1 },
          { tipo: 'discesa', richiesta_id: 900002, posti: 1 }
        ]
      }
    ],
    legs: [
      { metres: 400, seconds: 60 },
      { metres: 469, seconds: 78 }
    ]
  };
}

const richieste = [
  {
    id: 900001,
    distanza_diretta_km: 0.869,
    tempo_diretto_secondi: 138,
    max_ritardo_minuti: 1,
    max_deviazione_pct: 20,
    max_fermate_intermedie: 1,
    min_km_tra_fermate: 0
  },
  {
    id: 900002,
    distanza_diretta_km: 0.469,
    tempo_diretto_secondi: 78,
    max_ritardo_minuti: 5,
    max_deviazione_pct: 20,
    max_fermate_intermedie: 1,
    min_km_tra_fermate: 0
  }
];

function verifica(nome, sosta, atteso, motivoAtteso = null) {
  const risultato = verificaQualitaFermate({
    itinerario: creaItinerario(sosta),
    richieste
  });

  assert.equal(risultato.ok, atteso, nome);

  if (motivoAtteso) {
    assert.equal(risultato.motivo, motivoAtteso, nome);
    assert.equal(risultato.richiestaId, 900001);
  }

  console.log({
    scenario: nome,
    sostaIntermediaSecondi: sosta,
    conforme: risultato.ok,
    motivo: risultato.motivo ?? null,
    richiestaId: risultato.richiestaId ?? null,
    tempoBordoSecondi: risultato.tempoBordoSecondi ?? null
  });
}

console.log('=== POPBUS V2 - QUALITA SOSTE INTERMEDIE ===');

verifica('Sosta breve', 30, true);

verifica(
  'Sosta eccessiva',
  90,
  false,
  'RITARDO_OPERATIVO_ECCESSIVO'
);

console.log('\nPASS: impatto delle soste verificato.');
