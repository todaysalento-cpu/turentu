import assert from 'node:assert/strict';
const at=p=>import(new URL('../'+p,import.meta.url).href);
const {costruisciSequenzaFermate}=await at('services/popbus/v2/popbus-stop-itinerary.service.js');
const {generaSequenzeStradaliFermate}=await at('services/popbus/v2/popbus-stop-sequencer.service.js');
const {valutaCombinazioniFermate}=await at('services/popbus/v2/popbus-stop-evaluator.service.js');
const {generaAlternativeFisichePixelShadow}=await at('services/popbus/v2/popbus-pixel-stop-bridge.service.js');
const {default:polyline}=await at('node_modules/polyline/src/polyline.js');
const up={fermata_id:11,lat:40,lon:18,distanza_metri:0},down={fermata_id:12,lat:40.01,lon:18.01,distanza_metri:0};
const assignment=id=>({richiesta_id:id,start_territoriale:0,end_territoriale:1,posti_richiesti:1,salita:up,discesa:down});
const t=Date.parse('2027-04-01T10:00:00Z');
const route=async(a,b)=>({metres:1500,seconds:300,polyline:polyline.encode([[a.lat,a.lon],[b.lat,b.lon]]),roadCoincident:false});
const rs=[{id:1,start_datetime:new Date(t).toISOString(),posti_richiesti:1,min_km_tra_fermate:0,prezzo:20}];
const results=[];
async function test(name,fn){const start=performance.now();try{const evidence=await fn();const r={name,status:'PASS',ms:performance.now()-start,evidence};results.push(r);console.log(JSON.stringify(r));}catch(error){const r={name,status:'FAIL',ms:performance.now()-start,error:error.message};results.push(r);console.log(JSON.stringify(r));}}
await test('B: true capacity rejection explains NESSUNA_SEQUENZA_AMMISSIBILE',async()=>{
 const result=await valutaCombinazioniFermate({combinazioni:[{assegnazioni:[assignment(1),assignment(2)],scorePreliminare:0}],richieste:[...rs,{...rs[0],id:2}],postiTotali:1,departure:t,routing:route});
 assert.equal(result.valide.length,0);assert.equal(result.scartate[0].motivo,'NESSUNA_SEQUENZA_AMMISSIBILE');assert.ok(result.scartate[0].diagnosticaSequenziamento.sequenzeScartateEventi>0);
 return {rejection:result.scartate[0],classification:'correct rejection: mandatory simultaneous occupancy 2 exceeds capacity 1'};
});
await test('B: road-provider exception must not certify exhaustive negative search',async()=>{
 const result=await valutaCombinazioniFermate({combinazioni:[{assegnazioni:[assignment(1)],scorePreliminare:0}],richieste:rs,postiTotali:1,departure:t,routing:async()=>{throw Error('TEST_PROVIDER_UNAVAILABLE');}});
 console.log('ROUTING_FAILURE_EVIDENCE:'+JSON.stringify(result));
 assert.equal(result.diagnostica.sequenziamentoEsaustivo,false,'Provider unavailable is inconclusive, not an exhaustive negative');
});
await test('B: positive physical itinerary remains valid with deterministic road fixture',async()=>{
 const result=await valutaCombinazioniFermate({combinazioni:[{assegnazioni:[assignment(1)],scorePreliminare:0}],richieste:rs,postiTotali:1,departure:t,routing:route});
 assert.equal(result.valide.length,1);assert.equal(result.valide[0].temporale.ok,true);assert.equal(result.valide[0].qualita.ok,true);
});
await test('B: truncating road sequences must not certify exhaustive output',async()=>{
 const a=[assignment(1),{...assignment(2),salita:{...up,fermata_id:13,lat:40.001},discesa:{...down,fermata_id:14,lat:40.011}}];
 const seq=costruisciSequenzaFermate({assegnazioni:a,postiTotali:2,verificaCapienza:false});
 const result=await generaSequenzeStradaliFermate({sequenza:seq,routing:route,maxSequenze:1});
 console.log('SEQUENCE_LIMIT_EVIDENCE:'+JSON.stringify(result.diagnostica));
  assert.equal(result.diagnostica.outputLimitato,true);
  const evaluation=await valutaCombinazioniFermate({combinazioni:[{assegnazioni:a,scorePreliminare:0}],richieste:[...rs,{...rs[0],id:2}],postiTotali:2,departure:t,routing:route,maxSequenzePerCombinazione:1});
  console.log('TRUNCATED_EVALUATION_EVIDENCE:'+JSON.stringify(evaluation.diagnostica));
  assert.equal(evaluation.diagnostica.sequenziamentoEsaustivo,false,'Downstream evaluation must preserve that not all road sequences were returned');
});
await test('B: real stop bridge propagates incompleteness and preserves a valid physical alternative',async()=>{
 const run=routing=>generaAlternativeFisichePixelShadow({client:{query:async()=>{throw Error('REAL_DB_FORBIDDEN');}},formazione:{pixelOpportunitaId:1,pixelDirettriceId:2,pixelVersione:1,corridoioPixelId:'territorial:1>2',nodiTerritoriali:[1,2],departure:t,evaluation:{requests:[{id:1,start:0,end:1,posti_richiesti:1}]}},richieste:rs,postiTotali:1,routing,servizi:{cercaFermateCandidate:async()=>[{richiesta_id:1,salita:[up],discesa:[down]}]}});
 const valid=await run(route);assert.equal(valid.alternativeFisiche.length,1);assert.equal(valid.diagnostica.ricercaEsaustiva,true);
 const unknown=await run(async()=>{throw Error('TEST_PROVIDER_UNAVAILABLE');});assert.equal(unknown.alternativeFisiche.length,0);assert.equal(unknown.diagnostica.ricercaEsaustiva,false);
});
if(results.some(r=>r.status==='FAIL'))process.exitCode=1;
