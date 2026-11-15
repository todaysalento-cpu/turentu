import assert from 'node:assert/strict';
import test from 'node:test';
import { createIncrementalCorridorEngine } from '../services/pixel/incremental-corridor-engine.js';
import { generaFormazioniAlternative } from '../services/popbus/v2/model.js';

async function fixture({ ritornoAlle = '10:00', routingInversoDisponibile = true } = {}) {
  const legs = nodes => nodes.slice(1).map((node, i) => ({
    metres: 15000, seconds: 1200, polyline: `route-${nodes[i]}-${node}`
  }));
  const engine = createIncrementalCorridorEngine({
    initialCorridors: [{ id: 'andata', nodes: [1, 2, 3], legs: legs([1, 2, 3]) }],
    abilitaVariantiP1: true,
    routeNodes: async nodes => {
      if (!routingInversoDisponibile && nodes.join('>') === '3>2>1') {
        throw new Error('Percorso inverso non disponibile');
      }
      return { verificataRouting: true, legs: legs(nodes) };
    }
  });
  const rows = [[1, 1, 3, '09:00'], [2, 3, 1, ritornoAlle], [3, 2, 1, ritornoAlle]]
    .map(([id, start, end, time]) => ({
      id, start_node_id: start, end_node_id: end,
      origine_nodo_territoriale_id: start, destinazione_nodo_territoriale_id: end,
      start_datetime: `2035-11-15T${time}:00Z`, posti_richiesti: 1, prezzo: 20
    }));
  for (const row of rows) await engine.processRequest(row);
  return { engine, rows };
}

const isReturn = corridor => corridor.nodes.join('>') === '3>2>1';

test('promuove il ritorno sul corridoio inverso e rende valutabili le richieste insieme', async () => {
  const { engine, rows } = await fixture();
  assert.equal(engine.listCorridors().some(isReturn), false);

  const added = await engine.materializzaDirettriciRitorno();
  const returnCorridor = added.map(id => engine.getCorridor(id)).find(isReturn);
  assert.ok(returnCorridor);
  assert.equal(returnCorridor.legs[0].polyline, 'route-3-2');
  assert.deepEqual(returnCorridor.richiestaIds, [2, 3]);

  const [group] = await engine.temporalCandidatesCompleteWithReturns(returnCorridor.id);
  assert.deepEqual(group.richiestaIds, [2, 3]);
  const { inizioMs: start, fineMs: end } = group.finestraPartenza;
  const [formation] = generaFormazioniAlternative(
    returnCorridor, rows.filter(row => group.richiestaIds.includes(row.id)),
    group.richiestaIds, { departureWindow: { start, end } }
  );
  assert.deepEqual(formation.requests.map(r => r.id), [2, 3]);
  assert.equal(formation.peak, 2);

  await engine.materializzaDirettriciRitorno();
  assert.equal(engine.listCorridors().filter(isReturn).length, 1);
});

test('non crea il ritorno quando le finestre precedono la fine dell’andata', async () => {
  const { engine } = await fixture({ ritornoAlle: '07:30' });
  await engine.materializzaDirettriciRitorno();
  assert.equal(engine.listCorridors().some(isReturn), false);
});

test('non materializza un percorso privo di routing verificato', async () => {
  const { engine } = await fixture({ routingInversoDisponibile: false });
  await engine.materializzaDirettriciRitorno();
  assert.equal(engine.listCorridors().some(isReturn), false);
});
