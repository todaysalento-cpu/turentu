import assert from 'node:assert/strict';
const model=await import('../services/popbus/v2/model.js');
const {generaFormazioniArSafe}=await import('../services/popbus/v2/pixel-ar-safe-formations.js');
const t=Date.parse('2027-04-01T10:00:00Z');
const plan={nodes:[1,2,3],legs:[{metres:5000,seconds:600,roadCoincident:false},{metres:5000,seconds:600,roadCoincident:false}]};
const req=(id,extra={})=>({id,start_node_id:1,end_node_id:3,start_datetime:new Date(t).toISOString(),posti_richiesti:1,prezzo:id===1?1:20,ar_vincolata:false,ar_group_id:null,ar_tratta:null,...extra});
const key=e=>e.requests.map(r=>r.id).sort((a,b)=>a-b).join(',');
const results=[];
async function check(name,fn){const start=performance.now();const evidence=await fn();const r={name,status:'PASS',ms:performance.now()-start,evidence};results.push(r);console.log(JSON.stringify(r));}
let seed=7919;
const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/2**32);
await check('120 deterministic differential cases versus exhaustive subset oracle',()=>{
 for(let scenario=0;scenario<120;scenario++){
  const n=3+Math.floor(random()*4),rs=Array.from({length:n},(_,i)=>req(i+1,{start_node_id:random()<.3?2:1,posti_richiesti:1+Math.floor(random()*3),start_datetime:new Date(t+Math.floor(random()*130-40)*60000).toISOString(),...(random()<.15?{end_node_id:1}:{})}));
  const required=[1],opts={maxFormazioni:500,maxPeak:1+Math.floor(random()*6),qualityEnabled:scenario%3!==0,...(scenario%4===0?{excludeIds:[n]}:{}),...(scenario%5===0?{includeIds:[2]}:{}),...(scenario%6===0?{departureWindow:{start:t,end:t+60000}}:{})};
  const expected=new Set();
  for(let mask=1;mask<2**n;mask++){
   const ids=rs.filter((_,i)=>mask&(1<<i)).map(r=>r.id);
   if(![...required,...(opts.includeIds||[])].every(x=>ids.includes(x))||ids.some(x=>opts.excludeIds?.includes(x)))continue;
   const e=model.valutaRichieste(plan,rs,required,{...opts,mode:'seeds_only',includeIds:ids});if(e)expected.add(key(e));
  }
  const actual=model.generaFormazioniAlternative(plan,rs,required,opts);
  assert.equal(actual.length,new Set(actual.map(key)).size);
  assert.deepEqual(actual.map(key).sort(),[...expected].sort(),'Scenario '+scenario);
  assert.deepEqual(model.generaFormazioniAlternative(plan,[...rs].reverse(),required,opts).map(key).sort(),[...expected].sort(),'Order dependence '+scenario);
 }
 return {cases:120,reversedInputs:120};
});
await check('Budget exhaustion is explicit; exact-boundary output remains complete',()=>{
 const rs=[1,2,3,4].map(id=>req(id));
 assert.equal(model.generaFormazioniAlternative(plan,rs,[1],{maxFormazioni:8}).length,8);
 assert.throws(()=>model.generaFormazioniAlternative(plan,rs,[1],{maxFormazioni:7}),/nessun risultato parziale/);
 assert.throws(()=>model.generaFormazioniAlternative(plan,rs,[1],{maxFormazioni:100,maxValutazioniFormazioni:1}),/Limite valutazioni/);
 assert.throws(()=>model.generaFormazioniAlternative(plan,rs,[1],{maxValutazioniFormazioni:0}),/non valido/);
});
await check('Capacity-excluded greedy alternatives are still explored',()=>{
 const rs=[req(1),req(2,{posti_richiesti:2}),req(3,{posti_richiesti:2})];
 const found=model.generaFormazioniAlternative(plan,rs,[1],{maxPeak:3}).map(key);
 assert.ok(found.includes('1,2'));assert.ok(found.includes('1,3'));assert.ok(!found.includes('1,2,3'));
});
const run=m=>generaFormazioniArSafe({plan,requests:[1,2,3,4].map(id=>req(id)),seeds:[1,2,3,4],registro:{esclusiIds:[],arPairs:[]},generaFormazioniAlternative:m.generaFormazioniAlternative,valutaRichieste:m.valutaRichieste,maxSeeds:100,maxFormazioni:120});
await check('Original reproduction now retains all 15 groups and the EUR 60 formation',()=>{
 const fixed=run(model);
assert.equal(fixed.formazioni.length,15);
 assert.equal(Math.max(...fixed.formazioni.filter(e=>e.peak<=3).map(e=>e.revenue)),60);
});
