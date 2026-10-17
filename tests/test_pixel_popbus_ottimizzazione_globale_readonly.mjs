// TURENTU — TEST 6: selezione globale di cicli concorrenti, SOLA LETTURA.
// Copiare in tests/test_pixel_popbus_ottimizzazione_globale_readonly.mjs
// Nessun import: NON tocca worker, database, planner o corse reali.
// Fixture di cicli sintetici: la validazione dei cicli reali resta coperta dal Test 5.
import { performance } from 'node:perf_hooks';

const checks = [];
const check = (name, ok, detail = undefined) => checks.push({ test: name, pass: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
const T0 = Date.parse('2030-04-01T10:00:00Z');
const min = n => T0 + n * 60000;
const cycle = (id, vehicleId, ownerId, requests, start, end, marginCents, extra={}) => ({
  id, vehicleId, ownerId, requests, start: min(start), end: min(end), marginCents, ...extra
});
const overlaps = (a,b) => a.start < b.end && b.start < a.end; // intervalli [inizio,fine)
const incompatible = (a,b) => a.requests.some(r=>b.requests.includes(r)) || (a.vehicleId === b.vehicleId && overlaps(a,b));
const valid = c => Number.isInteger(c.marginCents) && c.marginCents > 0 && Number.isFinite(c.start) && Number.isFinite(c.end) && c.start < c.end &&
  c.requests.length > 0 && new Set(c.requests).size === c.requests.length && c.vehicleId != null && c.ownerId != null;
const score = xs => ({marginCents:xs.reduce((s,c)=>s+c.marginCents,0), served:new Set(xs.flatMap(c=>c.requests)).size, missions:xs.length});
const compare = (a,b) => a.marginCents-b.marginCents || a.served-b.served || a.missions-b.missions;
const solutionOK = xs => xs.every(valid) && xs.every((c,i)=>xs.slice(i+1).every(d=>!incompatible(c,d)));

// Greedy: margine individuale decrescente, nessuna ottimizzazione combinatoria.
function greedy(candidates) {
  const chosen=[];
  for(const c of [...candidates].filter(valid).sort((a,b)=>b.marginCents-a.marginCents || String(a.id).localeCompare(String(b.id)))) {
    if(chosen.every(x=>!incompatible(x,c))) chosen.push(c);
  }
  return chosen;
}

// Componenti connesse del grafo dei conflitti: le componenti non si influenzano.
function components(candidates) {
  const a=candidates.filter(valid), n=a.length;
  const adj=Array.from({length:n},()=>[]);
  for(let i=0;i<n;i++) for(let j=i+1;j<n;j++) if(incompatible(a[i],a[j])) {adj[i].push(j);adj[j].push(i);}
  const seen=new Set(), out=[];
  for(let i=0;i<n;i++) if(!seen.has(i)) {
    const stack=[i], group=[]; seen.add(i);
    while(stack.length){const u=stack.pop();group.push(a[u]);for(const v of adj[u]) if(!seen.has(v)){seen.add(v);stack.push(v);}}
    out.push(group);
  }
  return out;
}

// Ricerca esatta branch-and-bound per componenti fino a 20 candidate.
// Non è un ottimizzatore pronto per la produzione: >20 => fallback dichiarato.
function exactComponent(group) {
  const a=[...group].sort((x,y)=>y.marginCents-x.marginCents || String(x.id).localeCompare(String(y.id)));
  const n=a.length, remaining=Array(n+1).fill(0);
  for(let i=n-1;i>=0;i--) remaining[i]=remaining[i+1]+a[i].marginCents;
  let best=[], bestScore=score(best), visited=0;
  function visit(i,selected,total){
    visited++;
    if(total+remaining[i]<bestScore.marginCents) return;
    if(i===n){const s=score(selected);if(compare(s,bestScore)>0){best=[...selected];bestScore=s;}return;}
    if(selected.every(x=>!incompatible(x,a[i]))) {selected.push(a[i]);visit(i+1,selected,total+a[i].marginCents);selected.pop();}
    visit(i+1,selected,total);
  }
  visit(0,[],0);
  return {chosen:best,visited};
}
function globalSelection(candidates,maxComponent=20) {
  const groups=components(candidates), chosen=[];
  let exactGroups=0, fallbackGroups=0, visited=0, largestComponent=0;
  for(const g of groups) {
    largestComponent=Math.max(largestComponent,g.length);
    if(g.length<=maxComponent) {const r=exactComponent(g);chosen.push(...r.chosen);visited+=r.visited;exactGroups++;}
    else {chosen.push(...greedy(g));fallbackGroups++;}
  }
  return {chosen,exact: fallbackGroups===0,exactGroups,fallbackGroups,largestComponent,visited};
}
function summarize(chosen) {const s=score(chosen);return {missioni:s.missions,richiesteServite:s.served,margineEuro:s.marginCents/100,veicoliUsati:new Set(chosen.map(x=>x.vehicleId)).size,ids:chosen.map(x=>x.id).sort(),duplicatiRichieste:s.served!==chosen.reduce((n,c)=>n+c.requests.length,0),conflitti:!solutionOK(chosen)};}

// Caso fondamentale: greedy sceglie A (35€), ottimo B+C (58€).
const core=[
  cycle('A',101,900,[1,2,3],0,90,3500),
  cycle('B',102,900,[1,4],0,60,3000),
  cycle('C',103,900,[2,5],0,60,2800)
];
const cg=greedy(core), co=globalSelection(core);
check('Greedy sceglie A e ottiene 35 euro',score(cg).marginCents===3500 && cg.length===1);
check('Ottimo globale sceglie B+C e ottiene 58 euro',score(co.chosen).marginCents===5800 && co.chosen.length===2);
check('Due mezzi distinti stesso titolare operano contemporaneamente',co.chosen.every(c=>c.ownerId===900) && new Set(co.chosen.map(c=>c.vehicleId)).size===2);
check('Nessuna richiesta duplicata nell ottimo',solutionOK(co.chosen));
check('Ottimo certificato senza fallback',co.exact);

// Conflitti veicolo: anche senza richieste comuni, stesso mezzo non può sovrapporsi.
const sameVehicle=[cycle('V1',200,901,[10],0,40,1800),cycle('V2',200,901,[11],20,50,1700),cycle('V3',200,901,[12],40,80,1500)];
const sv=globalSelection(sameVehicle);
check('Stesso veicolo: missioni sovrapposte escluse',solutionOK(sv.chosen));
check('Intervalli adiacenti consentiti',sv.chosen.map(x=>x.id).sort().join(',')==='V1,V3');
check('Stesso veicolo: margine ottimo 33 euro',score(sv.chosen).marginCents===3300);

// Input non valido: esclusione esplicita e non selezione di cicli antieconomici.
const bad=[cycle('NEG',1,1,[50],0,10,-100),cycle('DUP',1,1,[51,51],0,10,1000),cycle('ZERO',1,1,[52],0,10,0)];
check('Cicli non validi o antieconomici esclusi',globalSelection(bad).chosen.length===0);

// Fixture deterministicamente ripetibile: ogni gruppo di 5 cicli è indipendente.
// Ogni blocco ha conflitti sia per richieste sia per veicolo.
function dataset(count){
  const out=[];
  for(let i=0;i<count;i++){
    const g=Math.floor(i/5), p=i%5, r=1000+g*10, owner=700+Math.floor(g/2), vehicle=10000+g*3;
    const entries=[
      {requests:[r,r+1],start:0,end:50,margin:3500,v:vehicle},
      {requests:[r,r+2],start:0,end:30,margin:3000,v:vehicle+1},
      {requests:[r+1,r+3],start:0,end:30,margin:2800,v:vehicle+2},
      {requests:[r+4],start:10,end:40,margin:1300,v:vehicle},
      {requests:[r+5],start:50,end:80,margin:1200,v:vehicle}
    ];
    const e=entries[p];out.push(cycle(`G${g}-C${p}`,e.v,owner,e.requests,g*100+e.start,g*100+e.end,e.margin));
  }
  return out;
}
const benchmark=[];
for(const count of [20,50,100]) {
  const data=dataset(count);
  const t1=performance.now(), g=greedy(data), t2=performance.now(), opt=globalSelection(data), t3=performance.now();
  const gs=summarize(g), os=summarize(opt.chosen);
  benchmark.push({candidate:count,greedy:{...gs,tempoMs:Number((t2-t1).toFixed(3))},globale:{...os,tempoMs:Number((t3-t2).toFixed(3)),esatto:opt.exact,componentiEsatte:opt.exactGroups,componentiFallback:opt.fallbackGroups,componenteMassima:opt.largestComponent,nodiVisitati:opt.visited}});
  check(`${count} candidate: selezione globale senza conflitti`,solutionOK(opt.chosen));
  check(`${count} candidate: nessun fallback`,opt.exact);
  check(`${count} candidate: margine globale >= greedy`,score(opt.chosen).marginCents>=score(g).marginCents);
  check(`${count} candidate: nessun duplicato di richieste`,!os.duplicatiRichieste);
  check(`${count} candidate: risultati deterministici`,globalSelection(data).chosen.map(x=>x.id).sort().join('|')===opt.chosen.map(x=>x.id).sort().join('|'));
}

// Controprova: una componente da 21 cicli NON viene dichiarata ottima se va in fallback.
const oversized=Array.from({length:21},(_,i)=>cycle(`BIG-${i}`,500,950,[9000+i],0,60,1000+i));
const fb=globalSelection(oversized);
check('Componente oltre soglia: fallback esplicitamente segnalato',fb.exact===false && fb.fallbackGroups===1 && fb.largestComponent===21);
check('Fallback conserva vincoli di conflitto',solutionOK(fb.chosen));

const report={
  test:'TURENTU TEST 6 — OTTIMIZZAZIONE GLOBALE CICLI CONCORRENTI',
  modalita:'SOLA LETTURA — fixture sintetiche, nessun import DB/worker/adapter',
  avvertenze:[
    'Questo test valuta un selettore sperimentale incluso nel file: NON prova che il selettore POPBUS esistente sia ottimo.',
    'Le candidate sono cicli sintetici già considerati validi: non richiama diagnosticaCicloPixelPopbus.',
    'Obiettivo dell ottimizzazione: margine totale in centesimi; copertura è una metrica secondaria per i pareggi.',
    'Il test non verifica routing reale, turni fisici, transazioni, disponibilita DB o generazione PIXEL.',
    'Ottimo esatto solo se ogni componente di conflitto ha al massimo 20 candidate; altrimenti fallback greedy segnalato.',
    'Tempi di esecuzione dipendono dalla macchina e non misurano il worker reale.'
  ],
  esempioGreedyVsGlobale:{greedy:summarize(cg),globale:summarize(co.chosen),margineExtraEuro:(score(co.chosen).marginCents-score(cg).marginCents)/100},
  testConflittoVeicolo:summarize(sv.chosen),
  benchmark,
  fallbackGrandeComponente:{dimensione:fb.largestComponent,esatto:fb.exact,fallback:fb.fallbackGroups},
  checks,passed:checks.filter(x=>x.pass).length,failed:checks.filter(x=>!x.pass).length
};
console.log(JSON.stringify(report,null,2));
if(report.failed) process.exitCode=1;
