import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';import path from 'node:path';
const root=process.cwd(),results=[];
const ctx=vm.createContext({process:{env:{},pid:1},structuredClone,performance});
const source=fs.readFileSync(path.join(root,'workers/pixel-observation-once.js'),'utf8');
const mod=new vm.SourceTextModule(source,{context:ctx});
const forbidden=()=>{throw Error('Real dependency forbidden');};
const deps={'../db/db.js':{pool:{}},'../services/popbus/v2/planner.js':{leg:forbidden},'polyline':{default:{encode:forbidden}},'../services/popbus/v2/pixel-first-multimission-service.js':{processaPixelFirstMultimissione:forbidden},'./popbus-pixel-first.worker.js':{getPixelFirstWorkerStatus:()=>({scheduled:false,running:false})}};
await mod.link(spec=>{assert.ok(spec in deps);const values=deps[spec];return new vm.SyntheticModule(Object.keys(values),function(){for(const [k,v]of Object.entries(values))this.setExport(k,v);},{context:ctx});});await mod.evaluate();
const factory=mod.namespace.createPixelObservationOnce;
const approved={POPBUS_PIXEL_OBSERVATION_ONCE_ALLOWED:'1',POPBUS_PIXEL_FIRST_ENABLED:'false',POPBUS_PIXEL_FIRST_MODE:'ROLLBACK_ONLY',POPBUS_WORKER_ENABLED:'false',POPBUS_PIXEL_FIRST_LIVE_APPROVED:'0',PIXEL_FIRST_PIPELINE_LIVE_APPROVED:'0',PIXEL_OPERATIONAL_LIVE_APPROVED:'0',POPBUS_PIXEL_OBSERVATION_IDS:'101,102',POPBUS_PIXEL_OBSERVATION_ROUTING_LIMIT:'2'};
const point=x=>({lat:40+x/100,lon:18});const result={diagnostica:{completo:true},dbWrites:0,missioniCandidateFisiche:2};
const test=async(name,fn)=>{await fn();results.push(name);console.log('PASS '+name);};
function make({env={},execute=async()=>result,route=async()=>({metres:1}),workerStatus=()=>({scheduled:false,running:false}),clock=()=>0}={}){return factory({env:{...approved,...env},execute,route,workerStatus,clock});}
await test('all permissions fail closed before any work',async()=>{for(const env of [{POPBUS_PIXEL_OBSERVATION_ONCE_ALLOWED:'0'},{POPBUS_PIXEL_FIRST_ENABLED:'true'},{POPBUS_PIXEL_FIRST_MODE:'LIVE'},{POPBUS_WORKER_ENABLED:'true'},{POPBUS_PIXEL_FIRST_LIVE_APPROVED:'1'},{PIXEL_FIRST_PIPELINE_LIVE_APPROVED:'1'},{PIXEL_OPERATIONAL_LIVE_APPROVED:'1'}])assert.throws(()=>make({env,execute:forbidden}).start(),/NOT_AUTHORIZED/);});
await test('IDs and quota cannot expand the approved perimeter',async()=>{for(const ids of ['', '1,2,3','1,1','-1','1e3','9007199254740992'])assert.throws(()=>make({env:{POPBUS_PIXEL_OBSERVATION_IDS:ids},execute:forbidden}).start(),/IDS_INVALID/);for(const quota of ['0','9','1.5',''])assert.throws(()=>make({env:{POPBUS_PIXEL_OBSERVATION_ROUTING_LIMIT:quota},execute:forbidden}).start(),/BUDGET_INVALID/);});
await test('active scheduler and draining worker block the observation',async()=>{for(const workerStatus of [()=>({scheduled:true}),()=>({running:true}),()=>({stopping:true})])assert.throws(()=>make({workerStatus,execute:forbidden}).start(),/WORKER_ACTIVE/);});
await test('single start passes only current read-only options, success is summarized',async()=>{let args;const o=make({execute:async x=>{args=x;return {...result,candidati:[{secret:'never returned'}]};}});assert.equal(o.start().state,'RUNNING');assert.throws(()=>o.start(),/ALREADY_USED/);await o.settled();assert.equal(o.status().state,'COMPLETED');assert.equal(args.mode,'ROLLBACK_ONLY');assert.equal(args.physicalShadow,true);assert.equal(args.physicalCycleShadow,true);assert.equal(args.physicalOpportunityIds.join(','),'101,102');assert.equal(args.physicalTransactionTest,undefined);assert.equal(args.physicalPersistenceTest,undefined);assert.equal(o.status().candidati,undefined);assert.throws(()=>o.start(),/ALREADY_USED/);});
await test('shared quota covers both candidate and selector routing; failures still consume reservations',async()=>{let provider=0;const o=make({route:async()=>{provider++;throw Error('provider failure');},execute:async args=>{for(let n=0;n<6;n++)try{await args.physicalShadowRouting(point(n),point(n+1));}catch{}return result;}});o.start();await o.settled();assert.equal(provider,2);assert.equal(o.status().routingReservations,2);assert.equal(o.status().state,'INCOMPLETE');assert.equal(o.status().reason,'PIXEL_OBSERVATION_ROUTING_BUDGET');});
await test('simultaneous identical legs share one reservation and promise',async()=>{let provider=0;const o=make({route:async()=>{provider++;return {metres:1};},execute:async args=>{await Promise.all(Array.from({length:10},()=>args.physicalShadowRouting(point(0),point(1))));return result;}});o.start();await o.settled();assert.equal(provider,1);assert.equal(o.status().routingReservations,1);});
await test('deadline prevents starting additional routing without pretending to cancel in-flight work',async()=>{let now=0,provider=0;const o=make({clock:()=>now,route:async()=>{provider++;now=30000;return {metres:1};},execute:async args=>{await args.physicalShadowRouting(point(0),point(1));await args.physicalShadowRouting(point(1),point(2));return result;}});o.start();await o.settled();assert.equal(provider,1);assert.equal(o.status().reason,'PIXEL_OBSERVATION_ROUTING_DEADLINE');});
await test('partial results, writes and unexpected errors cannot become success or auto-retry',async()=>{for(const execute of [async()=>({...result,parziale:true}),async()=>({...result,dbWrites:1}),async()=>{throw Error('sensitive details');}]){const o=make({execute});o.start();await o.settled();assert.notEqual(o.status().state,'COMPLETED');assert.ok(!JSON.stringify(o.status()).includes('sensitive'));assert.throws(()=>o.start(),/ALREADY_USED/);}});
// Verify injection boundaries on the actual service before its SQL or providers.
const service=fs.readFileSync(path.join(root,'services/popbus/v2/pixel-first-multimission-service.js'),'utf8');
const declaration=service.slice(service.indexOf('  if (physicalShadowRouting !== null'),service.indexOf('  // Il filtro opportunita'));
const check=Function('physicalShadowRouting','physicalShadow','mode','physicalTransactionTest','physicalPersistenceTest','rollbackTestHook','historicalPhysicalShadow','fail',declaration);
await test('routing injection is barred from LIVE, writer tests and historical shadow',async()=>{for(const values of [[false,'LIVE',false,false,null,false],[true,'LIVE',false,false,null,false],[true,'ROLLBACK_ONLY',true,false,null,false],[true,'ROLLBACK_ONLY',false,true,null,false],[true,'ROLLBACK_ONLY',false,false,()=>{},false],[true,'ROLLBACK_ONLY',false,false,null,true]])assert.throws(()=>check(()=>{},...values,x=>{throw Error(x);}));check(()=>{},true,'ROLLBACK_ONLY',false,false,null,false,x=>{throw Error(x);});});
await test('actual selector service shares the bounded routing in candidates and cycle selection',async()=>{
 const c=vm.createContext({process:{env:{POPBUS_SHADOW_COMMITMENTS_CACHE:'0'}},performance,console:{log(){},warn(){},error(){}}});const dependencies={};
 for(const m of service.matchAll(/^\s*import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/gm)){
  dependencies[m[2]]=Object.fromEntries(m[1].split(',').map(x=>x.trim()).filter(Boolean).map(x=>[x,forbidden]));
 }
 dependencies.polyline={default:{encode:forbidden}};
 dependencies['./popbus-worker-limits.js'].leggiLimiteOpportunita=()=>64;
 dependencies['./pixel-opportunity-adapter.js'].leggiContestiOpportunitaPixel=async()=>[];
 let injected=0,rollbacks=0;
 dependencies['./popbus-physical-multimission-candidates.js'].preparaCandidatiFisiciMultimissione=async args=>{await args.routing(point(0),point(1));return {candidati:[],diagnostica:{completo:true}};};
 dependencies['./popbus-physical-cycle-selector.js'].selezionaCicliFisiciShadow=async args=>{await args.movement(point(1),point(2));return {migliorCiclo:null};};
 const module=new vm.SourceTextModule(service,{context:c});await module.link(spec=>{assert.ok(spec in dependencies,spec);const values=dependencies[spec];return new vm.SyntheticModule(Object.keys(values),function(){for(const [k,v]of Object.entries(values))this.setExport(k,v);},{context:c});});await module.evaluate();
 const pool={connect:async()=>({query:async sql=>{assert.ok(sql.startsWith('BEGIN TRANSACTION')||sql==='ROLLBACK');if(sql==='ROLLBACK')rollbacks++;return {rows:[]};},release(){}})};
 const result=await module.namespace.processaPixelFirstMultimissione({pool,mode:'ROLLBACK_ONLY',physicalShadow:true,physicalCycleShadow:true,physicalShadowRouting:async()=>{injected++;return {metres:1};}});
 assert.equal(injected,2);assert.equal(rollbacks,1);assert.equal(result.dbWrites,0);
});
await test('new HTTP observation routes enforce admin JWT and do not restart an operation',async()=>{
 const {createRequire}=await import('node:module');const require=createRequire(path.join(root,'package.json'));const express=require('express'),jwt=require('jsonwebtoken');const secret='local-observation-test-'+Date.now();
 let calls=0;const state={state:'IDLE'};
 const values={'../../workers/pixel-canary-once.js':{startPixelCanaryOnce:forbidden,getPixelCanaryStatus:forbidden},express:{default:express},jsonwebtoken:{default:jwt},'../../config/security.js':{JWT_SECRET:secret},'../../workers/popbus-pixel-first.worker.js':{getPixelFirstWorkerStatus:()=>({scheduled:false}),stopPixelFirstWorker:async()=>{}},'../../workers/pixel-observation-once.js':{startPixelObservationOnce:forbidden,getPixelObservationOnceStatus:()=>state}};
 const routeModule=new vm.SourceTextModule(fs.readFileSync(path.join(root,'routes/admin/pixel-worker.routes.js'),'utf8'),{context:ctx});await routeModule.link(spec=>{assert.ok(spec in values,spec);const exports=values[spec];return new vm.SyntheticModule(Object.keys(exports),function(){for(const [k,v]of Object.entries(exports))this.setExport(k,v);},{context:ctx});});await routeModule.evaluate();
 const app=express();app.use('/worker',routeModule.namespace.createPixelWorkerControlRouter({observe:()=>{if(calls)throw Object.assign(Error('used'),{status:409,code:'PIXEL_OBSERVATION_ALREADY_USED'});calls++;state.state='RUNNING';return state;},observationStatus:()=>state}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const url='http://127.0.0.1:'+server.address().port+'/worker';const admin=jwt.sign({role:'admin'},secret),user=jwt.sign({role:'cliente'},secret);
 const post=token=>fetch(url+'/observe-once',{method:'POST',headers:token?{Authorization:'Bearer '+token}:{}});
 try{assert.equal((await post()).status,401);assert.equal((await post(user)).status,403);assert.equal(calls,0);assert.equal((await post(admin)).status,202);assert.equal((await post(admin)).status,409);assert.equal(calls,1);const response=await fetch(url+'/observation',{headers:{Authorization:'Bearer '+admin}});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal((await response.json()).state,'RUNNING');}finally{await new Promise(r=>server.close(r));}
});
await test('missing or expired selected opportunities fail the observation scope guard',async()=>{
 const a=service.indexOf('    if (routing && scopedIds !== null)'),b=service.indexOf('    // Diagnostica esclusivamente SHADOW',a);assert.ok(a>0&&b>a);
 const validate=Function('routing','scopedIds','snapshot','nowMs','fail',service.slice(a,b));const fail=x=>{throw Error(x);};
 const valid={pixel_opportunita_id:101,window:{end:200},requests:[{conferma_entro:null}]};
 validate(()=>{},[101],{contexts:[valid]},100,fail);
 for(const contexts of [[],[{...valid,pixel_opportunita_id:102}],[{...valid,window:{end:100}}],[{...valid,requests:[{conferma_entro:new Date(99).toISOString()}]}]])assert.throws(()=>validate(()=>{},[101],{contexts},100,fail),/mancante o scaduto/);
});
console.log(JSON.stringify({passed:results.length,providerCalls:'fixture only',databaseConnections:0}));
