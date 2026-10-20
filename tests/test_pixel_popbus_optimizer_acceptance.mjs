import assert from 'node:assert/strict';
import { ottimizzaFlotta } from '../services/popbus/v2/fleet-optimizer.ar-readonly.js';

const start = '2026-11-01T09:00:00.000Z';
const end = '2026-11-01T10:00:00.000Z';
const candidate = (veicolo, richieste, margine, from=start, to=end) => ({
  veicolo, richieste, partenza_base:from, ritorno_base:to,
  margine_ciclo_con_attesa_euro:margine
});
const opts = { maxNodi:100000, maxCandidati:100 };
const tests = [
  ['due veicoli simultanei', () => {
    const r=ottimizzaFlotta([candidate(1,[11],10),candidate(2,[12],20)],opts);
    assert.deepEqual(r.richiesteIds,[11,12]); assert.equal(r.margineTotaleEuro,30);
  }],
  ['richiesta unica tra proposte concorrenti', () => {
    const r=ottimizzaFlotta([candidate(1,[11],10),candidate(2,[11],20)],opts);
    assert.deepEqual(r.richiesteIds,[11]); assert.equal(r.margineTotaleEuro,20);
  }],
  ['nessuna sovrapposizione dello stesso veicolo', () => {
    const r=ottimizzaFlotta([candidate(1,[11],10),candidate(1,[12],20)],opts);
    assert.deepEqual(r.richiesteIds,[12]); assert.equal(r.margineTotaleEuro,20);
  }],
  ['stesso veicolo in cicli consecutivi', () => {
    const r=ottimizzaFlotta([
      candidate(1,[11],10,'2026-11-01T09:00:00Z','2026-11-01T10:00:00Z'),
      candidate(1,[12],20,'2026-11-01T10:00:00Z','2026-11-01T11:00:00Z')],opts);
    assert.deepEqual(r.richiesteIds,[11,12]); assert.equal(r.margineTotaleEuro,30);
  }],
  ['A/R negativa + positiva, insieme redditizie', () => {
    const r=ottimizzaFlotta([candidate(1,[101],-10),candidate(2,[201],30)],
      {...opts,arPairs:[{andata:101,ritorno:201}]});
    assert.deepEqual(r.richiesteIds,[101,201]); assert.equal(r.margineTotaleEuro,20);
  }],
  ['A/R incompleta esclusa; ordinaria indipendente', () => {
    const r=ottimizzaFlotta([candidate(1,[101],40),candidate(2,[301],10)],
      {...opts,arPairs:[{andata:101,ritorno:201}]});
    assert.deepEqual(r.richiesteIds,[301]); assert.equal(r.margineTotaleEuro,10);
  }],
  ['A/R nella stessa candidata', () => {
    const r=ottimizzaFlotta([candidate(1,[101,201],15)],
      {...opts,arPairs:[{andata:101,ritorno:201}]});
    assert.deepEqual(r.richiesteIds,[101,201]); assert.equal(r.margineTotaleEuro,15);
  }],
  ['A/R con margine totale negativo esclusa', () => {
    const r=ottimizzaFlotta([candidate(1,[101],-30),candidate(2,[201],10)],
      {...opts,arPairs:[{andata:101,ritorno:201}]});
    assert.deepEqual(r.richiesteIds,[]); assert.equal(r.margineTotaleEuro,0);
  }],
  ['limite nodi A/R: fail closed', () => {
    assert.throws(()=>ottimizzaFlotta([candidate(1,[101],10),candidate(2,[201],10)],
      {maxNodi:1,maxCandidati:100,arPairs:[{andata:101,ritorno:201}]}),/AR_NODI_LIMIT/);
  }],
];
let failed=0;
for(const [name,fn] of tests){
  try{fn();console.log(`PASS ${name}`);}catch(e){failed++;console.error(`FAIL ${name}: ${e.stack||e}`);}
}
console.log(`PIXEL_POPBUS_OPTIMIZER_ACCEPTANCE: ${tests.length-failed}/${tests.length} passed`);
if(failed) process.exitCode=1;
