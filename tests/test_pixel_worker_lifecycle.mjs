// Run from repository root with node --experimental-vm-modules tests/test_pixel_worker_lifecycle.mjs.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {randomBytes} from 'node:crypto';
const root=process.cwd(),require=createRequire(path.join(root,'package.json'));
const express=require('express'),jwt=require('jsonwebtoken'),cron=require('node-cron');
const results=[];
const test=async(name,fn)=>{await fn();results.push(name);console.log('PASS '+name);};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {resolve,promise};};
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const baseEnv={POPBUS_PIXEL_FIRST:'1',POPBUS_PIXEL_FIRST_ENABLED:'true',POPBUS_PIXEL_FIRST_MODE:'ROLLBACK_ONLY',PIXEL_FIRST_PIPELINE_ENABLED:'0'};
function context(env={}){return vm.createContext({process:{env:{...baseEnv,...env},pid:process.pid},console:{log(){},warn(){},error(){}},performance,setTimeout,clearTimeout});}
async function load(file,ctx,deps={}){
 const mod=new vm.SourceTextModule(read(file),{context:ctx,identifier:file});
 await mod.link(spec=>{assert.ok(spec in deps,'Unexpected real dependency: '+spec);const exports=deps[spec];return new vm.SyntheticModule(Object.keys(exports),function(){for(const [k,v]of Object.entries(exports))this.setExport(k,v);},{context:ctx});});
 await mod.evaluate();return mod.namespace;
}
const scheduler=await load('workers/pixel-first-scheduler.js',context());
function harness(run){const callbacks=[];let destroyed=0;const control=scheduler.createPixelFirstScheduler({schedule:(expr,fn,opts)=>{assert.equal(expr,'* * * * *');assert.equal(opts.noOverlap,true);callbacks.push(fn);return {destroy:async()=>{destroyed++;}};},run,logger:{error(){}}});return {control,callbacks,destroyed:()=>destroyed};}
await test('stop idle destroys task, invalidates queued callbacks and is repeatable',async()=>{let runs=0;const h=harness(()=>runs++);h.control.start();h.control.start();assert.equal(h.callbacks.length,1);await h.control.stop();await h.callbacks[0]();await h.control.stop();assert.equal(runs,0);assert.equal(h.destroyed(),1);assert.equal(h.control.status().scheduled,false);assert.equal(h.control.status().stopping,false);});
await test('in-flight cycle drains without cancellation; overlapping ticks are ignored',async()=>{const d=deferred();let runs=0;const h=harness(async()=>{runs++;await d.promise;});h.control.start();const cycle=h.callbacks[0]();await Promise.resolve();await h.callbacks[0]();assert.equal(runs,1);let stopped=false;const stop=h.control.stop().then(()=>{stopped=true;});await Promise.resolve();assert.equal(stopped,false);assert.throws(()=>h.control.start(),/DRAINING/);d.resolve();await cycle;await stop;assert.equal(h.control.status().running,false);assert.equal(h.control.status().last.ok,true);});
await test('bounded stop reports running, blocks restart until drained, old callbacks stay invalid',async()=>{const d=deferred();const h=harness(()=>d.promise);h.control.start();const cycle=h.callbacks[0]();await Promise.resolve();await h.control.stop({waitMs:1});assert.equal(h.control.status().running,true);assert.equal(h.control.status().scheduled,false);assert.throws(()=>h.control.start(),/DRAINING/);d.resolve();await cycle;h.control.start();await h.callbacks[0]();assert.equal(h.control.status().running,false);await h.control.stop();});
await test('simultaneous stop requests share the same drain operation',async()=>{const d=deferred();const h=harness(()=>d.promise);h.control.start();const cycle=h.callbacks[0]();await Promise.resolve();const a=h.control.stop(),b=h.control.stop();assert.equal(a,b);d.resolve();await cycle;await a;assert.equal(h.destroyed(),1);});
await test('cycle failure releases guard and a later cycle succeeds',async()=>{let n=0;const h=harness(()=>{if(++n===1)throw Error('fixture');});h.control.start();await h.callbacks[0]();assert.equal(h.control.status().last.ok,false);await h.callbacks[0]();assert.equal(h.control.status().last.ok,true);await h.control.stop();assert.throws(()=>h.control.stop({waitMs:-1}),/INVALID/);});
await test('real node-cron task is destroyed without closing a separate HTTP server',async()=>{let task;const c=scheduler.createPixelFirstScheduler({schedule:(expr,fn,opts)=>(task=cron.schedule(expr,()=>fn(),opts)),run:async()=>{}});const app=express();app.get('/health',(req,res)=>res.send('ok'));const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));try{c.start();await c.stop();assert.equal(task.getStatus(),'destroyed');assert.equal(await(await fetch('http://127.0.0.1:'+server.address().port+'/health')).text(),'ok');}finally{await new Promise(r=>server.close(r));}});
async function worker(env={},run=async()=>({offerte:0})){const ctx=context(env);let scheduled=0;const ns=await load('workers/popbus-pixel-first.worker.js',ctx,{'node-cron':{default:{schedule(){scheduled++;return {destroy:async()=>{}};}}},'../services/popbus/v2/worker.js':{processaProposteDinamicheV2:run},'../services/pixel/pixel-operational.service.js':{processaPixelOperativo:async()=>({committed:false})},'./pixel-first-scheduler.js':{createPixelFirstScheduler:scheduler.createPixelFirstScheduler}});return {ns,ctx,scheduled:()=>scheduled};}
await test('physical observation is rejected with LIVE before PIXEL/POPBUS work',async()=>{let runs=0;const h=await worker({POPBUS_PIXEL_FIRST_MODE:'LIVE',POPBUS_PIXEL_PHYSICAL_OBSERVATION:'1',POPBUS_PIXEL_FIRST_LIVE_APPROVED:'1',POPBUS_MULTIMISSION_ACCEPTANCE_TEST:'true',POPBUS_PIXEL_COSTO_ATTESA_ORA_EURO:'10'},()=>runs++);assert.throws(()=>h.ns.startPixelFirstWorker(),/REQUIRES_ROLLBACK/);await assert.rejects(h.ns.eseguiCicloPixelFirstControllato(),/REQUIRES_ROLLBACK/);assert.equal(runs,0);assert.equal(h.scheduled(),0);});
await test('LIVE authorization remains required; invalid observation flag fails closed',async()=>{const live=await worker({POPBUS_PIXEL_FIRST_MODE:'LIVE'});assert.throws(()=>live.ns.startPixelFirstWorker(),/LIVE non autorizzato/);const invalid=await worker({POPBUS_PIXEL_PHYSICAL_OBSERVATION:'true'});assert.throws(()=>invalid.ns.startPixelFirstWorker(),/OBSERVATION_INVALID/);});
await test('physical observation propagates only read-only selector options through actual V2 worker',async()=>{
 const ctx=context({POPBUS_PIXEL_PHYSICAL_OBSERVATION:'1'}),source=read('services/popbus/v2/worker.js');let received=null;
 const dependencies={};
 for(const m of source.matchAll(/^\s*import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/gm)){
  const exports={};for(const name of m[1].split(',').map(x=>x.trim()).filter(Boolean))exports[name]=()=>{throw Error('Unexpected side effect: '+name);};
  dependencies[m[2]]=exports;
 }
 dependencies['../../../db/db.js'].pool={connect(){throw Error('Unexpected DB connection');}};
 dependencies['./pixel-first-multimission-service.js'].processaPixelFirstMultimissione=async args=>{received=args;return {offerte:0,dbWrites:0};};
 const mod=await load('services/popbus/v2/worker.js',ctx,dependencies);await mod.processaProposteDinamicheV2();
 assert.equal(received.mode,'ROLLBACK_ONLY');assert.equal(received.physicalShadow,true);assert.equal(received.physicalCycleShadow,true);assert.equal(received.physicalPersistenceTest,undefined);assert.equal(received.rollbackTestHook,undefined);
 ctx.process.env.POPBUS_PIXEL_FIRST_MODE='LIVE';received=null;await assert.rejects(mod.processaProposteDinamicheV2(),/REQUIRES_PIXEL_FIRST_ROLLBACK/);assert.equal(received,null);
});
await test('actual HTTP control: JWT/role checks, validation, draining response and API stays up',async()=>{
 const secret=randomBytes(32).toString('hex'),h=harness(async()=>{}),ctx=context();let stops=0,running=false;
 const mod=await load('routes/admin/pixel-worker.routes.js',ctx,{'express':{default:express},'../../workers/pixel-observation-once.js':{startPixelObservationOnce:()=>{throw Error('Observation not requested');},getPixelObservationOnceStatus:()=>({state:'IDLE'})},'jsonwebtoken':{default:jwt},'../../config/security.js':{JWT_SECRET:secret},'../../workers/popbus-pixel-first.worker.js':{getPixelFirstWorkerStatus:h.control.status,stopPixelFirstWorker:h.control.stop}});
 const app=express();app.use(express.json());app.use('/worker',mod.createPixelWorkerControlRouter({status:()=>({scheduled:false,running}),stop:async()=>{stops++;}}));app.get('/health',(req,res)=>res.send('ok'));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const url='http://127.0.0.1:'+server.address().port;
 const admin=jwt.sign({id:1,role:'admin'},secret),user=jwt.sign({id:2,role:'cliente'},secret),expired=jwt.sign({id:1,role:'admin',exp:1},secret);
 const request=(token,body={},cookie)=>fetch(url+'/worker/stop',{method:'POST',headers:{'content-type':'application/json',...(token?{Authorization:'Bearer '+token}:{}),...(cookie?{Cookie:'token='+cookie}:{})},body:JSON.stringify(body)});
 try{
  assert.equal((await request(null,{},admin)).status,401);assert.equal((await request('bad')).status,401);assert.equal((await request(expired)).status,401);assert.equal((await request(user)).status,403);assert.equal((await request(admin,{waitMs:-1})).status,400);assert.equal(stops,0);
  assert.equal((await request(admin)).status,200);running=true;assert.equal((await request(admin,{waitMs:0})).status,202);assert.equal(stops,2);
  const response=await fetch(url+'/worker',{headers:{Authorization:'Bearer '+admin}});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(await(await fetch(url+'/health')).text(),'ok');
 }finally{await new Promise(r=>server.close(r));}
});
console.log(JSON.stringify({passed:results.length,providerCalls:0,databaseConnections:0,tests:results}));
