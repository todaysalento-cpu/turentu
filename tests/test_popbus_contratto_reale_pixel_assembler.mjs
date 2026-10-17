// TURENTU POPBUS - TEST 9: CONTRATTO MODEL -> PIXEL -> ASSEMBLER
// SOLA LETTURA: nessuna query DB, nessuna scrittura, nessuna chiamata Stripe.
// Salva come tests/test_popbus_contratto_reale_pixel_assembler.mjs
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const modelPath = path.join(root, 'services/popbus/v2/model.js');
const adapterPath = path.join(root, 'services/pixel/pixel-popbus-cycle-adapter.js');
const assemblerPath = path.join(root, 'services/popbus/v2/popbus-single-corsa-assembler.js');
let pass = 0, fail = 0, gaps = 0;
function check(ok, title, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${title}${detail ? ' - ' + detail : ''}`);
  ok ? pass++ : fail++;
}
function gap(title, detail) { gaps++; console.log(`GAP ${title} - ${detail}`); }
function leg(metres=10000, seconds=1800) { return {metres, seconds, polyline:'_p~iF~ps|U_ulLnnqC', roadVerified:true}; }
const t0 = Date.parse('2027-04-01T08:00:00.000Z');
const nodes = [
  {id:7,lat:40.3515,lon:18.1750,nome_nodo:'Lecce'},
  {id:5,lat:40.1200,lon:18.2900,nome_nodo:'Maglie'},
  {id:8,lat:39.9300,lon:18.3500,nome_nodo:'Tricase'},
];
const baseRequests = [
  {id:101,start_node_id:7,end_node_id:5,start_datetime:new Date(t0).toISOString(),posti_richiesti:2,prezzo:90,classe:'STANDARD'},
  {id:102,start_node_id:5,end_node_id:8,start_datetime:new Date(t0+3000000).toISOString(),posti_richiesti:3,prezzo:90,classe:'STANDARD'},
  {id:103,start_node_id:8,end_node_id:7,start_datetime:new Date(t0+6000000).toISOString(),posti_richiesti:2,prezzo:90,classe:'STANDARD'},
];
console.log('=== TURENTU POPBUS / TEST 9 CONTRATTO REALE MODEL-PIXEL-ASSEMBLER ===');
for (const p of [modelPath, adapterPath, assemblerPath]) check(fs.existsSync(p), `File presente: ${path.relative(root,p)}`);
if (fail) process.exitCode = 1;
else {
 try {
  const {valutaRichieste} = await import(pathToFileURL(modelPath).href);
  const {diagnosticaCicloPixelPopbus} = await import(pathToFileURL(adapterPath).href);
  const {componiCicloInCorsa} = await import(pathToFileURL(assemblerPath).href);
  const m = [{corridorId:'m1',nodes:[7,5],requestIds:[101]}, {corridorId:'m2',nodes:[5,8],requestIds:[102]}, {corridorId:'m3',nodes:[8,7],requestIds:[103]}];
  const corridors = new Map(m.map(x=>[x.corridorId,{nodes:x.nodes,legs:[leg()],richiestaIds:x.requestIds}]));
  const requestMap = new Map(baseRequests.map(x=>[x.id,x]));
  const engine = {getCorridor:id=>corridors.get(id),getRequest:id=>requestMap.get(Number(id))};
  const vehicle = {id:353,driver_id:2,posti_totali:4,euro_km:0.5,lat:40.3515,lon:18.175};
  const e = valutaRichieste({nodes:[7,5],legs:[leg()]},[baseRequests[0]],[101],{mode:'seeds_only',maxPeak:4});
  check(Boolean(e), 'MODEL valutaRichieste restituisce una valutazione');
  if(e) {
   check(e.peak===2 && e.occupancy?.[0]===2, 'MODEL calcola correttamente peak e occupancy');
   if (e.requests?.[0]?.posti_richiesti == null) gap('MODEL non propaga posti_richiesti', 'evaluation.requests contiene solo id/start/end');
   else check(e.requests[0].posti_richiesti===2,'MODEL propaga posti_richiesti');
  }
  const road = async (a,b) => {
   if (Math.abs(a.lat-b.lat)<1e-7 && Math.abs(a.lon-b.lon)<1e-7) return {metres:0,seconds:0,roadCoincident:true};
   return leg(1000,60);
  };
  const result = await diagnosticaCicloPixelPopbus({engine,missioni:m.map(x=>({corridorId:x.corridorId,requestIds:x.requestIds})),richieste:baseRequests,vehicle,nodes,road,now:t0-86400000,validateVehicle:async()=>true,validateCandidate:async()=>true});
  console.log('DIAGNOSTICA ADAPTER',JSON.stringify({ok:result.ok,motivo:result.motivo,numeroMissioni:result.missioni?.length,validazionePreliminare:result.validazionePreliminare,attivabile:result.attivabile},null,2));
  check(Array.isArray(result.missioni)&&result.missioni.length===3,'PIXEL produce tre missioni',result.motivo||'');
  if(result.missioni?.length===3) {
   check(result.missioni.every(x=>Array.isArray(x.legs)&&x.legs.length===1),'PIXEL propaga legs');
   check(result.trasferimenti?.length===2 && result.trasferimenti.every(x=>x.leg),'PIXEL propaga geometria trasferimenti');
   const missing = result.missioni.flatMap(x=>x.requests.filter(r=>r.posti_richiesti==null).map(r=>r.id));
   if(missing.length) gap('PIXEL perde posti_richiesti','ID richieste: '+missing.join(','));
   else check(true,'PIXEL propaga posti_richiesti');
   const params = {missioni:result.missioni,trasferimenti:result.trasferimenti,nodi:nodes,veicoloId:vehicle.id,busyStart:result.busyStart,busyEnd:result.busyEnd,approach:result.approach,returnTrip:result.returnTrip,postiTotali:vehicle.posti_totali};
   let raw;
   try { raw=componiCicloInCorsa(params); check(true,'ASSEMBLER accetta output reale adapter'); }
   catch(err) {check(false,'ASSEMBLER accetta output reale adapter',err.message);}
   if(raw) {
    if(raw.validazioneCapienza?.verificata) check(raw.evaluation.peak===3,'Capienza globale verificata con dati diretti');
    else gap('Capienza globale non verificata','Mancano posti_richiesti negli oggetti di missione');
    check(raw.attivabile===false,'Piano resta non attivabile');
   }
   // SIMULAZIONE SOLO IN MEMORIA: arricchimento adapter con la fonte richieste validata.
   const enriched = result.missioni.map(x=>({...x,requests:x.requests.map(r=>({...r,posti_richiesti:requestMap.get(Number(r.id))?.posti_richiesti}))}));
   try {
    const normalized=componiCicloInCorsa({...params,missioni:enriched});
    check(normalized.validazioneCapienza?.verificata===true,'SIMULAZIONE: arricchimento posti consente validazione');
    check(normalized.evaluation.peak===3,'SIMULAZIONE: peak globale = 3');
    check(normalized.validazioneCapienza?.totalePasseggeri===7,'SIMULAZIONE: passeggeri trasportati = 7');
    check(normalized.attivabile===false,'SIMULAZIONE: attivazione sempre disabilitata');
    console.log('RIEPILOGO CICLO',JSON.stringify({nodes:normalized.nodes,requests:normalized.evaluation.requests,occupazione:normalized.validazioneCapienza.occupazioneSegmenti,peak:normalized.evaluation.peak,attivabile:normalized.attivabile},null,2));
   } catch(err) {check(false,'SIMULAZIONE: integrazione con arricchimento',err.message);}
  }
 } catch(err) {check(false,'Esecuzione moduli',err.stack||err.message);}
}
console.log('\nESITO',JSON.stringify({pass,fail,gap:gaps,modalita:'SOLA_LETTURA'},null,2));
if(fail) process.exitCode=1;
