// TURENTU — Test regressione propagazione metadati A/R (SOLA LETTURA)
// Copiare in tests/test_pixel_ar_propagazione_readonly.js
// Eseguire: node tests\test_pixel_ar_propagazione_readonly.js
// Non apre connessioni DB, non modifica file o tabelle.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const modelPath = resolve(root, 'services/popbus/v2/model.js');
const sourcePath = resolve(root, 'services/popbus/v2/pixel-worker-formation-source.js');
const adapterPath = resolve(root, 'services/popbus/v2/pixel-opportunity-adapter.js');
const modelText = readFileSync(modelPath, 'utf8');
const sourceText = readFileSync(sourcePath, 'utf8');
const adapterText = readFileSync(adapterPath, 'utf8');
const { valutaRichieste, generaFormazioniAlternative } = await import(pathToFileURL(modelPath).href);
const future = new Date(Date.now() + 10 * 24 * 3600_000).toISOString();
const plan = { nodes: [1001,1002], legs: [{metres:12000,seconds:900,polyline:'test'}] };
const group = '00000000-0000-4000-8000-000000000001';
const req = (id, extra={}) => ({id,start_node_id:1001,end_node_id:1002,start_datetime:future,posti_richiesti:1,prezzo:15,classe:'STANDARD',...extra});
const checks=[];
function check(name, fn) { fn(); checks.push(name); console.log('PASS',name); }

check('valutazione ordinaria mantiene id/start/end', () => {
  const x=valutaRichieste(plan,[req(11)],[11],{mode:'seeds_only'});
  assert.ok(x); assert.equal(x.requests[0].id,11); assert.equal(x.requests[0].start,0); assert.equal(x.requests[0].end,1);
});
check('ordinaria usa A/R null e false', () => {
  const x=valutaRichieste(plan,[req(11)],[11],{mode:'seeds_only'});
  assert.equal(x.requests[0].ar_group_id,null); assert.equal(x.requests[0].ar_tratta,null); assert.equal(x.requests[0].ar_vincolata,false);
});
check('andata conserva gruppo, tratta e vincolo', () => {
  const x=valutaRichieste(plan,[req(301,{ar_group_id:group,ar_tratta:'andata',ar_vincolata:true})],[301],{mode:'seeds_only'});
  assert.deepEqual([x.requests[0].ar_group_id,x.requests[0].ar_tratta,x.requests[0].ar_vincolata],[group,'andata',true]);
});
check('ritorno conserva gruppo, tratta e vincolo', () => {
  const x=valutaRichieste(plan,[req(302,{ar_group_id:group,ar_tratta:'ritorno',ar_vincolata:true})],[302],{mode:'seeds_only'});
  assert.deepEqual([x.requests[0].ar_group_id,x.requests[0].ar_tratta,x.requests[0].ar_vincolata],[group,'ritorno',true]);
});
check('ricavo ordinario invariato', () => {
  const x=valutaRichieste(plan,[req(11,{prezzo:12.50})],[11],{mode:'seeds_only'});
  assert.equal(x.revenue,12.50);
});
check('ricavo A/R resta potenziale nella formazione', () => {
  const x=valutaRichieste(plan,[req(301,{prezzo:18,ar_group_id:group,ar_tratta:'andata',ar_vincolata:true})],[301],{mode:'seeds_only'});
  assert.equal(x.revenue,18);
});
check('formazioni alternative conservano i metadati A/R', () => {
  const formations=generaFormazioniAlternative(plan,[req(301,{ar_group_id:group,ar_tratta:'andata',ar_vincolata:true}),req(11)],[301],{maxFormazioni:20});
  assert.ok(formations.length>0);
  assert.ok(formations.every(f=>f.requests.find(r=>r.id===301)?.ar_group_id===group));
  assert.ok(formations.some(f=>f.requests.some(r=>r.id===11)));
});
check('adapter legge righe complete e source conserva evaluation', () => {
  assert.match(adapterText,/SELECT\s+\*\s+FROM\s+public\.richieste_pop_bus/i);
  assert.match(adapterText,/\.\.\.row/);
  assert.match(sourceText,/evaluation:\s*f\.evaluation/);
});

const summary={passed:true,checksPassed:checks.length,checksTotal:8,dbWrites:0,workerModified:false,scope:'propagazione model + audit statico adapter/source; NON prova gate A/R o commit atomico'};
console.log('PIXEL_AR_PROPAGAZIONE_READONLY_JSON:'+JSON.stringify(summary));
