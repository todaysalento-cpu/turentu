import assert from 'node:assert/strict';
import test from 'node:test';
import { preparaCandidatiFisiciMultimissione } from '../services/popbus/v2/popbus-physical-multimission-candidates.js';

function fixture(capienze = [4, 4, 4, 4, 4], numeroFormazioni = 51) {
  const richieste = Array.from({ length: numeroFormazioni }, (_, i) => ({
    id: i + 1, posti_richiesti: 1, prezzo: 20
  }));
  const departure = Date.parse('2035-11-15T08:00:00Z');
  const chiamate = [];
  const options = {
    client: { query: () => { throw new Error('Il test non accede al database'); } },
    snapshot: {
      contexts: [{ requests: richieste }],
      missioni: richieste.map(({ id }) => ({
        pixelOpportunitaId: 99, pixelDirettriceId: 1, pixelVersione: 1,
        corridoioPixelId: 'territorial:1>2', plan: { nodes: [1, 2] }, peak: 1,
        departure, evaluation: { requests: [{ id }] }
      })),
      vehicles: capienze.map((posti_totali, i) => ({ id: i + 1, posti_totali }))
    },
    bridge: async ({ richieste, postiTotali }) => {
      const [{ id }] = richieste;
      chiamate.push({ id, postiTotali });
      const diagnostica = { ricercaEsaustiva: true };
      if (id !== numeroFormazioni) {
        return { ok: false, motivo: 'SCARTO_CONTROLLATO', diagnostica, alternativeFisiche: [] };
      }
      return { ok: true, diagnostica, alternativeFisiche: [{
        missione: {
          nodes: [101, 102], legs: [{ metres: 15000, seconds: 1200 }],
          departure, arrival: departure + 1200000, requests: [{ id, start: 0, end: 1 }]
        },
        nodiFisici: [{ id: 101, lat: 40, lon: 18 }, { id: 102, lat: 40.1, lon: 18 }]
      }] };
    }
  };
  return { options, chiamate };
}

test('255 combinazioni richiedono 51 calcoli e conservano le cinque alternative fisiche', async () => {
  const { options, chiamate } = fixture();
  const result = await preparaCandidatiFisiciMultimissione({ ...options, maxTentativi: 250 });

  assert.equal(result.diagnostica.completo, true);
  assert.equal(result.diagnostica.tentativi, 255);
  assert.equal(result.diagnostica.calcoliFisici, 51);
  assert.equal(result.diagnostica.cacheHits, 204);
  assert.equal(result.diagnostica.combinazioniResidue, 0);
  assert.equal(chiamate.length, 51);
  assert.deepEqual(result.candidati.map(c => c.vehicleId), [1, 2, 3, 4, 5]);
});

test('il limite delle combinazioni include i riusi e segnala il residuo', async () => {
  const { options, chiamate } = fixture();
  const result = await preparaCandidatiFisiciMultimissione({
    ...options, maxTentativi: 250, maxCombinazioni: 250
  });

  assert.equal(result.parziale, true);
  assert.equal(result.attivabile, false);
  assert.equal(result.diagnostica.completo, false);
  assert.equal(result.diagnostica.interrottoPerBudget, true);
  assert.equal(result.diagnostica.budgetEsaurito, 'COMBINAZIONI');
  assert.equal(result.diagnostica.tentativi, 250);
  assert.equal(result.diagnostica.combinazioniResidue, 5);
  assert.equal(chiamate.length, 50);
  assert.equal(result.candidati.length, 0);
});

test('il limite dei calcoli consente riusi e si ferma alla successiva capienza non in cache', async () => {
  const { options, chiamate } = fixture([4, 4, 6], 1);
  const result = await preparaCandidatiFisiciMultimissione({
    ...options, maxTentativi: 1, maxCombinazioni: 3
  });

  assert.equal(result.parziale, true);
  assert.equal(result.diagnostica.budgetEsaurito, 'CALCOLI_FISICI');
  assert.equal(result.diagnostica.combinazioniResidue, 1);
  assert.equal(result.diagnostica.tentativi, 2);
  assert.equal(result.diagnostica.cacheHits, 1);
  assert.deepEqual(chiamate, [{ id: 1, postiTotali: 4 }]);
  assert.deepEqual(result.candidati.map(c => c.vehicleId), [1, 2]);
});
