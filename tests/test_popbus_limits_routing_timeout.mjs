import assert from 'node:assert/strict';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
const root=fileURLToPath(new URL('../',import.meta.url));
const {leggiLimiteOpportunita}=await import(pathToFileURL(root+'services/popbus/v2/popbus-worker-limits.js'));
const {getRouteGeometry}=await import(pathToFileURL(root+'utils/maps.util.js'));
const model=await import(pathToFileURL(root+'services/popbus/v2/model.js'));
const {generaFormazioniArSafe}=await import(pathToFileURL(root+'services/popbus/v2/pixel-ar-safe-formations.js'));
const output=[];
const test=async(name,fn)=>{const start=performance.now();const evidence=await fn();const r={name,status:'PASS',ms:performance.now()-start,evidence};output.push(r);console.log(JSON.stringify(r));};
await test('Bounded opportunities default 64, accepts 31/64/999, rejects invalid or overflow settings',()=>{
 assert.equal(leggiLimiteOpportunita({}),64);
 for(const n of [1,15,31,64,999])assert.equal(leggiLimiteOpportunita({POPBUS_PIXEL_MAX_OPPORTUNITA:String(n)}),n);
 for(const n of ['',0,-1,1000,'x',1.2,true])assert.throws(()=>leggiLimiteOpportunita({POPBUS_PIXEL_MAX_OPPORTUNITA:n}));
});
await test('Actual worker snapshot rejects overflow before reading vehicles or producing partial results',async()=>{
 const source=readFileSync(root+'services/popbus/v2/pixel-first-multimission-service.js','utf8');
 const start=source.indexOf('async function candidates(');
 const closing='return {contexts,missioni,vehicles,nodi,registro};\n}';
 const end=source.indexOf(closing,start)+closing.length;
 assert.ok(start>=0&&end>start);
 const factory=new Function('leggiContestiOpportunitaPixel','limits','fail','return ('+source.slice(start,end)+')');
 const candidates=factory(async args=>{assert.equal(args.limit,65);return Array.from({length:65},()=>({}));},{opportunita:leggiLimiteOpportunita({})},message=>{throw Error(message);});
 await assert.rejects(candidates({query:async()=>{throw Error('Unexpected query after overflow');}},Date.now()),/limite opportunita raggiunto: niente troncamento/);
});
await test('Real routing function preserves valid response and passes an abort signal',async()=>{
 const r=await getRouteGeometry({lat:40,lon:18},{lat:40.01,lon:18.01},{apiKey:'TEST_SECRET',fetchImpl:async(url,opts)=>{assert.ok(opts.signal instanceof AbortSignal);return {ok:true,json:async()=>({status:'OK',routes:[{overview_polyline:{points:'fixture'},legs:[{distance:{value:869},duration:{value:138}}]}]})};}});
 assert.equal(r.distanzaMetri,869);assert.equal(r.durata,138);
});
await test('Abort timer also covers slow response bodies',async()=>{
 const fetchImpl=async(url,{signal})=>({ok:true,json:()=>new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(Object.assign(new Error('TEST_SECRET'),{name:'AbortError'})),{once:true});})});
 await assert.rejects(getRouteGeometry({lat:40,lon:18},{lat:41,lon:19},{apiKey:'TEST_SECRET',timeoutMs:20,fetchImpl}),e=>e.code==='ROUTING_TIMEOUT'&&!e.message.includes('TEST_SECRET'));
});
await test('Provider errors do not expose keys or failed request URLs',async()=>{
 await assert.rejects(getRouteGeometry({lat:40,lon:18},{lat:41,lon:19},{apiKey:'TEST_SECRET',fetchImpl:async()=>{throw Error('https://example.invalid/?key=TEST_SECRET');}}),e=>e.code==='ROUTING_PROVIDER_ERROR'&&!e.message.includes('TEST_SECRET')&&!e.message.includes('https'));
});
for(const size of [15,31,64])await test('Complete bounded formation fixture across '+size+' opportunities',()=>{
 const plan={nodes:[1,2],legs:[{metres:1000,seconds:120,roadCoincident:false}]};let total=0;
 for(let i=0;i<size;i++){
  const requests=Array.from({length:4},(_,j)=>({id:i*4+j+1,start_node_id:1,end_node_id:2,start_datetime:'2027-04-01T10:00:00Z',posti_richiesti:1,prezzo:20,ar_vincolata:false,ar_group_id:null,ar_tratta:null}));
  const result=generaFormazioniArSafe({plan,requests,seeds:requests.map(r=>r.id),registro:{esclusiIds:[],arPairs:[]},generaFormazioniAlternative:model.generaFormazioniAlternative,valutaRichieste:model.valutaRichieste,maxFormazioni:120});assert.equal(result.formazioni.length,15);total+=result.formazioni.length;
 }
 return {opportunities:size,requestsPerOpportunity:4,formations:total,realRouting:false};
});
