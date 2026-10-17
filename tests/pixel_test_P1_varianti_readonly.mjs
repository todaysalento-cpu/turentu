import assert from 'node:assert/strict';
import { createIncrementalCorridorEngine } from '../services/pixel/incremental-corridor-engine.js';

let routingCalls = 0;
const routeNodes = async nodes => {
  routingCalls++;
  return { verificataRouting: true, legs: nodes.slice(1).map((n, i) => ({
    metres: 12000, seconds: 1200, polyline: `mock-${nodes[i]}-${n}`
  })) };
};
const req = (id, a, b) => ({
  id, origine_nodo_territoriale_id: a, destinazione_nodo_territoriale_id: b,
  start_datetime: '2026-10-16T09:00:00Z', posti_richiesti: 1
});
const create = () => createIncrementalCorridorEngine({
  routeNodes, abilitaVariantiP1: true, maxVariantiPerRichiesta: 12, maxNodiVariante: 8
});
const find = (e, path) => e.listCorridors().find(c => c.nodes.join('>') === path);
const has = (c, ids) => !!c && ids.every(id => c.richiestaIds.includes(id));

{
  const e = create();
  for (const r of [req(21,7,8), req(22,7,9), req(23,8,10), req(24,9,10)]) await e.processRequest(r);
  assert.ok(has(find(e,'7>8>10'),[21,23]), 'variante A assente o incompleta');
  assert.ok(has(find(e,'7>9>10'),[22,24]), 'variante B assente o incompleta');
  console.log('OK 1: varianti convergenti');
}
{
  const e = create();
  for (const r of [req(31,7,6), req(32,7,8), req(33,8,6)]) await e.processRequest(r);
  assert.ok(has(find(e,'7>8>6'),[31,32,33]), 'composizione intermedia assente');
  console.log('OK 2: composizione intermedia e appartenenza completa');
}
{
  const e = create();
  await e.processRequest(req(1,7,8));
  await e.processRequest(req(2,8,6));
  const count = e.listCorridors().length;
  const again = await e.processRequest(req(2,8,6));
  assert.equal(again.azione,'gia_presente');
  assert.equal(e.listCorridors().length,count);
  console.log('OK 3: idempotenza');
}
{
  const e = create();
  await Promise.all(Array.from({length:10},(_,i)=>e.processRequest(req(i+100,7,8))));
  assert.equal(e.listCorridors().filter(c=>c.nodes.join('>')==='7>8').length,1);
  assert.equal(e.mutationQueueState().pending,0);
  console.log('OK 4: concorrenza e assenza di duplicati');
}
console.log(`PIXEL P1: 4 test superati; ${routingCalls} routing mock; nessuna scrittura DB.`);
