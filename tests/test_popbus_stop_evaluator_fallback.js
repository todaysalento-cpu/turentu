
import assert from 'node:assert/strict';

import { valutaCombinazioniFermate }
  from '../services/popbus/v2/popbus-stop-evaluator.service.js';

import { TOLLERANZA_MS }
  from '../services/popbus/v2/model.js';

const BASE = Date.parse('2026-11-01T10:00:00+01:00');

const fermata14 = {
  fermata_id: 14,
  lat: 40.121583,
  lon: 18.305914
};

const fermata15 = {
  fermata_id: 15,
  lat: 40.1258486502909,
  lon: 18.299920672780097
};

const richiesta = {
  id: 900001,
  posti_richiesti: 1,
  start_datetime: new Date(BASE).toISOString(),
  distanza_diretta_km: 0.869,
  tempo_diretto_secondi: 138,
  max_deviazione_pct: 20,
  max_ritardo_minuti: 5,
  max_fermate_intermedie: 0,
  min_km_tra_fermate: 0
};

function combinazione(salita, discesa, score) {
  return {
    scorePreliminare: score,
    assegnazioni: [{
      richiesta_id: richiesta.id,
      start_territoriale: 0,
      end_territoriale: 1,
      posti_richiesti: 1,
      salita,
      discesa
    }]
  };
}

// Routing simulato, indipendente dal provider esterno.
async function routingSimulato(a, b) {
  const from = Number(a.fermata_id);
  const to = Number(b.fermata_id);

  if (from === 15 && to === 14) {
    return {
      metres: 882,
      seconds: 139,
      polyline: 'test-polyline'
    };
  }

  if (from === 14 && to === 15) {
    return {
      metres: 869,
      seconds: 138,
      polyline: 'test-polyline'
    };
  }

  throw new Error(`Tratta non prevista: ${from} -> ${to}`);
}

async function main() {
  console.log('=== POPBUS V2 - TEST FALLBACK COMBINAZIONI ===');

  console.log({
    tolleranzaConfigurataMinuti: TOLLERANZA_MS / 60000
  });

  const risultato = await valutaCombinazioniFermate({
    combinazioni: [
      combinazione(fermata15, fermata14, 100),
      combinazione(fermata14, fermata15, 200)
    ],
    richieste: [richiesta],
    postiTotali: 4,
    departure: BASE,
    routing: routingSimulato
  });

  assert.equal(risultato.ok, true);
  assert.equal(risultato.diagnostica.combinazioniValutate, 2);

  console.table(
    risultato.valide.map(v => ({
      indice: v.indice,
      kmMissione: v.kmMissione,
      stato: v.stato
    }))
  );

  console.table(
    risultato.scartate.map(s => ({
      indice: s.indice,
      fase: s.fase,
      motivo: s.motivo
    }))
  );

  console.log('Diagnostica:', risultato.diagnostica);

  assert.equal(
    risultato.valide.length + risultato.scartate.length,
    2
  );

  assert.equal(risultato.attivabile, false);

  console.log('\nTest diagnostico completato.');
}

main().catch(error => {
  console.error('FAIL:', error);
  process.exitCode = 1;
});
