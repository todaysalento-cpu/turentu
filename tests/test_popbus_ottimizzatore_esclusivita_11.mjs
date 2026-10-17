// TURENTU POPBUS V2 — TEST 11: ESCLUSIVITA' OTTIMIZZATORE
// SOLO LETTURA. Usa il modulo reale fleet-optimizer.js; nessun DB, Stripe o socket.
// Salva come tests/test_popbus_ottimizzatore_esclusivita_11.mjs
// Esegui: node tests/test_popbus_ottimizzatore_esclusivita_11.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root=process.cwd();
const optimizerPath=path.join(root,'services','popbus','v2','fleet-optimizer.js');
let pass=0, fail=0;
function test(name, fn) {
  try { fn(); pass++; console.log('PASS',name); }
  catch(e) { fail++; console.error('FAIL',name,'—',e.message); }
}
function candidate(id, vehicle, requests, start, end, margin, extra={}) {
  return {
    id, veicolo:vehicle, richieste:[requests],
    partenza_base:start, ritorno_base:end,
    margine_ciclo_con_attesa_euro:margin, ...extra
  };
}
function selectedIds(result) { return result.selezionati.map(x=>x.id).sort(); }
function noConflicts(result) {
  const used=new Set();
  for(const c of result.selezionati) {
    const ids=c.richieste.flat(Infinity).map(x=>typeof x==='object'?x.id:x);
    for(const id of ids) {
      assert(!used.has(Number(id)),`Richiesta duplicata ${id}`);
      used.add(Number(id));
    }
  }
  for(let i=0;i<result.selezionati.length;i++) {
    const a=result.selezionati[i];
    for(let j=i+1;j<result.selezionati.length;j++) {
      const b=result.selezionati[j];
      if(Number(a.veicolo)!==Number(b.veicolo)) continue;
      const as=new Date(a.partenza_base).getTime(), ae=new Date(a.ritorno_base).getTime();
      const bs=new Date(b.partenza_base).getTime(), be=new Date(b.ritorno_base).getTime();
      assert(!(as<be && bs<ae),`Veicolo ${a.veicolo} sovrapposto: ${a.id}/${b.id}`);
    }
  }
}
function oracle(candidates) {
  // Ricerca esaustiva INDIPENDENTE per campioni <= 12 candidati.
  let best=0;
  for(let mask=0;mask<(1<<candidates.length);mask++) {
    const chosen=candidates.filter((_,i)=>mask&(1<<i));
    const req=new Set();
    let valid=true, cents=0;
    for(let i=0;i<chosen.length && valid;i++) {
      const a=chosen[i];
      for(const id of a.richieste.flat(Infinity)) {
        const key=Number(typeof id==='object'?id.id:id);
        if(req.has(key)) { valid=false; break; }
        req.add(key);
      }
      for(let j=0;j<i;j++) {
        const b=chosen[j];
        if(a.veicolo===b.veicolo && a.partenza_base<b.ritorno_base &&
           b.partenza_base<a.ritorno_base) valid=false;
      }
      cents+=Math.round(a.margine_ciclo_con_attesa_euro*100);
    }
    if(valid && cents>best) best=cents;
  }
  return best/100;
}
console.log('=== TURENTU POPBUS / TEST 11 ESCLUSIVITA OTTIMIZZATORE ===');
if(!fs.existsSync(optimizerPath)) {
  console.error('FAIL File assente:',optimizerPath);
  process.exitCode=1;
} else {
  const {ottimizzaFlotta}=await import(pathToFileURL(optimizerPath).href);
  const run=(items, opts={})=>ottimizzaFlotta(items,{maxCandidati:500,maxNodi:100000,...opts});
  test('Modulo reale esporta ottimizzaFlotta',()=>assert.equal(typeof ottimizzaFlotta,'function'));

  test('Richiesta condivisa: sceglie solo il ciclo con margine maggiore',()=>{
    const r=run([candidate('A',353,[101,102],1000,4000,30),
                 candidate('B',354,[102,103],1000,4000,50)]);
    assert.deepEqual(selectedIds(r),['B']); noConflicts(r);
  });
  test('Veicolo uguale e finestre sovrapposte: esclusione',()=>{
    const r=run([candidate('A',353,[101],1000,4000,30),
                 candidate('B',353,[102],3000,5000,50)]);
    assert.deepEqual(selectedIds(r),['B']); noConflicts(r);
  });
  test('Sovrapposizione nell avvicinamento: esclusione base-base',()=>{
    const r=run([candidate('A',353,[101],1000,4000,30),
                 candidate('B',353,[102],2000,3000,50)]);
    assert.deepEqual(selectedIds(r),['B']); noConflicts(r);
  });
  test('Sovrapposizione nel ritorno: esclusione base-base',()=>{
    const r=run([candidate('A',353,[101],1000,6000,30),
                 candidate('B',353,[102],5000,7000,50)]);
    assert.deepEqual(selectedIds(r),['B']); noConflicts(r);
  });
  test('Intervalli contigui sullo stesso veicolo: consentiti',()=>{
    const r=run([candidate('A',353,[101],1000,4000,30),
                 candidate('B',353,[102],4000,7000,50)]);
    assert.deepEqual(selectedIds(r),['A','B']); noConflicts(r);
  });
  test('Veicoli distinti stesso titolare: missioni simultanee consentite',()=>{
    const r=run([candidate('A',353,[101],1000,4000,30,{titolareId:2}),
                 candidate('B',354,[102],1000,4000,50,{titolareId:2})]);
    assert.deepEqual(selectedIds(r),['A','B']); noConflicts(r);
  });
  test('Stessa richiesta su veicoli distinti: una sola assegnazione',()=>{
    const r=run([candidate('A',353,[101],1000,4000,30),
                 candidate('B',354,[101],1000,4000,50)]);
    assert.deepEqual(selectedIds(r),['B']); noConflicts(r);
  });
  test('Ciclo con tre missioni: ID annidati trattati come unita',()=>{
    const r=run([candidate('TRIPLA',353,[101,102,103],1000,8000,90),
                 candidate('CONFLITTO',354,[102],3000,5000,50),
                 candidate('INDIPENDENTE',355,[104],1000,5000,20)]);
    assert.deepEqual(selectedIds(r),['INDIPENDENTE','TRIPLA']); noConflicts(r);
  });
  test('Massimo margine globale, non scelta greedy',()=>{
    const r=run([candidate('A',353,[101,102],1000,8000,100),
                 candidate('B',353,[101],1000,4000,65),
                 candidate('C',353,[102],4000,8000,65)]);
    assert.deepEqual(selectedIds(r),['B','C']);
    assert.equal(r.margineTotaleEuro,130); noConflicts(r);
  });
  test('Margine negativo o zero: esclusi',()=>{
    const r=run([candidate('NEG',353,[101],1000,4000,-10),
                 candidate('ZERO',354,[102],1000,4000,0),
                 candidate('POS',355,[103],1000,4000,2)]);
    assert.deepEqual(selectedIds(r),['POS']); noConflicts(r);
  });
  test('Richieste duplicate nella stessa candidata: rifiuto',()=>{
    assert.throws(()=>run([candidate('BAD',353,[101,101],1000,4000,20)]),/duplicat/i);
  });
  test('Intervallo base-base invalido: rifiuto',()=>{
    assert.throws(()=>run([candidate('BAD',353,[101],4000,4000,20)]),/intervallo/i);
  });
  test('Capacita massima candidati: troncamento dichiarato',()=>{
    const r=run([candidate('A',353,[101],1000,4000,50),
                 candidate('B',354,[102],1000,4000,40)],{maxCandidati:1});
    assert.equal(r.candidatiTagliati,1);
    assert.equal(r.ottimoDimostrato,false);
  });
  test('Limite nodi: non dichiarare ottimo senza prova',()=>{
    const r=run([candidate('A',353,[101],1000,4000,50),
                 candidate('B',354,[102],1000,4000,40)],{maxNodi:1});
    assert.equal(r.limiteNodiRaggiunto,true);
    assert.equal(r.ottimoDimostrato,false);
  });
  test('Output selezionato mantiene riferimenti originali',()=>{
    const a=candidate('A',353,[101],1000,4000,20,{_corsaGlobale:{attivabile:false}});
    const r=run([a]);
    assert.equal(r.selezionati[0],a);
    assert.equal(r.selezionati[0]._corsaGlobale.attivabile,false);
  });

  // 30 scenari deterministici: confronta il margine con un oracolo esaustivo.
  let seed=20261016;
  function rand(){seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;}
  for(let round=1;round<=30;round++) {
    const items=Array.from({length:8},(_,i)=>{
      const vehicle=353+Math.floor(rand()*3);
      const req=[101+Math.floor(rand()*6)];
      if(rand()<0.35) {
        const extra=101+Math.floor(rand()*6);
        if(extra!==req[0]) req.push(extra);
      }
      const start=1000+Math.floor(rand()*5)*1000;
      const end=start+(1+Math.floor(rand()*3))*1000;
      const margin=1+Math.floor(rand()*60);
      return candidate(`R${round}_${i}`,vehicle,req,start,end,margin);
    });
    test(`Oracolo esaustivo scenario ${String(round).padStart(2,'0')}`,()=>{
      const r=run(items,{maxNodi:1000000});
      noConflicts(r);
      assert.equal(r.margineTotaleEuro,oracle(items));
      assert.equal(r.ottimoDimostrato,true);
      assert.equal(r.richiesteCoperte,new Set(r.selezionati.flatMap(c=>c.richieste.flat(Infinity))).size);
    });
  }
  console.log('\nRIEPILOGO',JSON.stringify({
    pass,fail,modalita:'SOLA LETTURA',
    testRandomEsaustivi:30,
    nota:'Verifica solo i vincoli interni dell ottimizzatore; non verifica DB, pagamenti, turni o acceptance.'
  },null,2));
  console.log(`ESITO: ${pass} PASS, ${fail} FAIL. Nessuna scrittura.`);
  if(fail) process.exitCode=1;
}
