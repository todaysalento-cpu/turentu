// TURENTU POPBUS V2 — TEST DIAGNOSTICO CICLO CONTIGUO
// Salvare come tests/test_popbus_v2_ciclo_completo.js
// CMD: node tests\test_popbus_v2_ciclo_completo.js
// Nessuna connessione DB, nessuna chiamata routing, nessuna attivazione.
// Il piano è sintetico: non prova che planner/worker lo costruiscano.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { generaCandidate } from '../services/popbus/v2/model.js';
import { verificaQualitaOccorrenze } from '../services/popbus/v2/service-quality.js';
import { generaRitorniCompatibili, valutaSogliaCiclo } from '../services/popbus/v2/return-matching.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const T0 = Date.parse('2027-04-01T08:00:00Z');
const iso = m => new Date(T0 + m * 60000).toISOString();
const richiesta = (id, start_node_id, end_node_id, min, prezzo, extra={}) => ({
  id, start_node_id, end_node_id, start_datetime: iso(min), prezzo,
  posti_richiesti: 1, classe: 'STANDARD',
  max_fermate_intermedie: 20, min_km_tra_fermate: 0,
  max_deviazione_pct: 100, ...extra
});
const ids = f => new Set(f.requestIds);
const contains = (f, ...wanted) => wanted.every(id => ids(f).has(id));
const tests=[];
function test(name, fn){ tests.push({name,fn}); }

// 1->2 M1; 2->5 collegamento; 5->3 M2; 3->4 M3;
// 4->6->1 ritorno finale (nodo 1 compare due volte).
// Ogni segmento: 20 km e 20 minuti, dati artificiali e deterministici.
const ciclo={
  nodes:[1,2,5,3,4,6,1],
  legs:Array.from({length:6},()=>({metres:20000,seconds:1200}))
};
const M1=richiesta(101,1,2,0,15);
const M2=richiesta(102,5,3,40,15);
const M3=richiesta(103,3,4,60,15);
const collegamento=richiesta(104,2,5,20,8);
const ritorno=richiesta(105,4,1,80,35);
const incompatibile=richiesta(106,4,1,200,200);
const alternative=richiesta(107,4,1,80,25);
const basi=[
  {richiesta:M1,start:0,end:1},
  {richiesta:M2,start:2,end:3},
  {richiesta:M3,start:3,end:4}
];
const opts={maxPosti:4,baseAssignments:basi,maxRisultati:100};
const all=()=>generaRitorniCompatibili(ciclo,[collegamento,ritorno,incompatibile],T0,opts);

// Le missioni devono essere in ordine cronologico, con connessione
// e ritorno fisico unico nel piano. Verifica del piano fornito,
// NON della generazione automatica del piano da parte del worker.
test('sequenza M1 → collegamento → M2 → M3 → ritorno',()=>{
  assert.deepEqual(ciclo.nodes,[1,2,5,3,4,6,1]);
  assert.equal(ciclo.legs.length,6);
  assert.equal(ciclo.nodes.filter(n=>n===1).length,2);
  assert.equal(ciclo.legs.reduce((s,l)=>s+l.seconds,0),7200);
});
test('qualità di tutte le richieste di andata',()=>{
  const q=verificaQualitaOccorrenze(ciclo,basi);
  assert.equal(q.ok,true,JSON.stringify(q));
});
test('collegamento può trasportare un passeggero',()=>{
  assert(all().some(f=>contains(f,101,102,103,104)));
});
test('ritorno può trasportare un passeggero',()=>{
  assert(all().some(f=>contains(f,101,102,103,105)));
});
test('collegamento e ritorno coesistono nello stesso ciclo',()=>{
  assert(all().some(f=>contains(f,101,102,103,104,105)));
});
test('ritorno fuori orario non contribuisce al ricavo',()=>{
  assert(all().every(f=>!ids(f).has(106)));
});
test('nessuna richiesta duplicata nella formazione',()=>{
  for(const f of all()) assert.equal(new Set(f.requestIds).size,f.requestIds.length);
});
test('costo del ciclo: un solo rientro finale',()=>{
  const kmCiclo=ciclo.legs.reduce((s,l)=>s+l.metres,0)/1000;
  const kmAvvicinamento=10;
  const euroKm=0.50;
  const costo=(kmCiclo+kmAvvicinamento)*euroKm;
  assert.equal(kmCiclo,120);
  assert.equal(costo,65);
  // Il costo è calcolato sui segmenti REALI del ciclo sintetico.
  // Non sommare i rientri teorici di M1 e M2.
});
test('soglia attivata dal ritorno compatibile, non da quello incompatibile',()=>{
  const f=all().find(x=>contains(x,101,102,103,105));
  const senza=all().find(x=>!ids(x).has(105)&&!ids(x).has(104));
  assert(f&&senza);
  const param={costEuro:65,thresholdRatio:0.90};
  assert.equal(valutaSogliaCiclo(senza,param).attivabile,false);
  assert.equal(valutaSogliaCiclo(f,param).attivabile,true);
});
test('richiesta incompatibile resta disponibile per altri cicli',()=>{
  const original=JSON.stringify(incompatibile);
  all();
  assert.equal(JSON.stringify(incompatibile),original);
});
test('capienza reale: formazione con sovrapposizione respinta',()=>{
  const lungo=richiesta(108,1,4,0,20,{posti_richiesti:4});
  const f=generaRitorniCompatibili(ciclo,[lungo],T0,opts);
  assert(f.every(x=>!ids(x).has(108)));
});
test('richieste alternative competono per lo stesso segmento',()=>{
  const f=generaRitorniCompatibili(ciclo,[ritorno,alternative],T0,{
    ...opts,maxPosti:1
  });
  assert(f.some(x=>ids(x).has(105)));
  assert(f.some(x=>ids(x).has(107)));
  assert(f.every(x=>!(ids(x).has(105)&&ids(x).has(107))));
});

let passed=0,failed=0;
console.log('\nTURENTU POPBUS V2 — TEST CICLO COMPLETO (PIANO SINTETICO)');
console.log('SOLA LETTURA | NO DB | NO ROUTING | NO ATTIVAZIONI\n');
for(const {name,fn} of tests){
  try { await fn(); passed++; console.log('✅ '+name); }
  catch(e){ failed++; console.error('❌ '+name+'\n   '+e.message); }
}
console.log(`\nTEST LOGICI: ${passed}/${tests.length} superati; ${failed} falliti`);

// Audit statico: segnala se il worker NON utilizza il modulo dei ritorni.
// Non viene importato il worker per evitare side effect (cron, socket, DB).
console.log('\nAUDIT INTEGRAZIONE WORKER (LETTURA FILE):');
const workerFile=resolve(ROOT,'services/popbus/v2/worker.js');
if(!existsSync(workerFile)){
  console.log('⚠️ worker.js non trovato: audit integrazione non eseguito');
}else{
  const source=readFileSync(workerFile,'utf8');
  const imported=/from\s*['"]\.\/return-matching\.js['"]/.test(source);
  const called=/\bgeneraRitorniCompatibili\s*\(/.test(source);
  console.log(imported?'✅ modulo return-matching importato':'⚠️ modulo return-matching NON importato');
  console.log(called?'✅ generaRitorniCompatibili richiamata':'⚠️ generaRitorniCompatibili NON richiamata');
  if(!imported||!called) console.log('GAP: ciclo contiguo non risulta integrato nel worker.');
  else console.log('NOTA: audit statico positivo non prova attivazione transazionale corretta.');
}
console.log('\nNON VERIFICATI: costruzione automatica ciclo, routing reale, disponibilità');
console.log('veicolo, costi reali, soglie di classe, commit atomico e concorrenza.');
if(failed) process.exitCode=1;
