/**
 * TURENTU POPBUS V2 - CONCATENAZIONE CONTROLLATA - SHADOW / NO DB
 * Installazione: tests/test_popbus_v2_concatenazione_controllata_shadow.js
 * Esecuzione: node tests\test_popbus_v2_concatenazione_controllata_shadow.js
 * Usa il generatore REALE, routing deterministico locale, nessuna scrittura o API.
 * Non valida attivazioni produttive. Non modifica alcun file applicativo.
 */
import assert from 'node:assert/strict';
import { generaCandidatiFlotta } from '../services/popbus/v2/fleet-candidates.js';

const now = Date.parse('2026-10-14T00:00:00Z');
const at = x => `2026-10-16T${x}:00Z`;
const sameInstant = (actual, expected) => assert.equal(Date.parse(actual), Date.parse(expected));
const nodes = [
  {id:1,lat:40.000,lon:18.000}, // A: origine missione 1
  {id:2,lat:40.100,lon:18.100}, // B: fine missione 1
  {id:3,lat:40.200,lon:18.200}, // C: inizio missione 2
  {id:4,lat:40.300,lon:18.300}  // D: fine missione 2
];
const base = {id:900,lat:40.400,lon:18.400,posti_totali:4,euro_km:1};
const routeMap = new Map([
  ['1>2',{metres:10000,seconds:1200}], // missione 1: 10 km, 20 min
  ['3>4',{metres:10000,seconds:1200}], // missione 2: 10 km, 20 min
  ['2>3',{metres:2000,seconds:300}],   // trasferimento: 2 km, 5 min
  ['900>1',{metres:3000,seconds:360}], // avvicinamento: 3 km, 6 min
  ['2>900',{metres:4000,seconds:480}],
  ['900>3',{metres:3000,seconds:360}],
  ['4>900',{metres:4000,seconds:480}]
]);
const byCoords = new Map([...nodes,base].map(p=>[`${p.lat},${p.lon}`,p.id]));
let roadCalls=0;
async function road(a,b) {
  roadCalls++;
  const aid=byCoords.get(`${a.lat},${a.lon}`);
  const bid=byCoords.get(`${b.lat},${b.lon}`);
  const result=routeMap.get(`${aid}>${bid}`);
  if(!result)throw Error(`Percorso non configurato: ${aid}>${bid}`);
  return {...result};
}
const r1={id:101,start_node_id:1,end_node_id:2,start_datetime:at('10:00'),posti_richiesti:2,prezzo:30,classe:'STANDARD'};
const r2={id:102,start_node_id:3,end_node_id:4,start_datetime:at('10:40'),posti_richiesti:2,prezzo:30,classe:'STANDARD'};
const opts={now,includePast:false,maxDepth:3,maxWaitMin:180,bufferMin:0,maxChains:500,
  maxFormations:40,maxGroupRequests:12,maxAggregateCombos:2500,
  maxCombosPerChainVehicle:20000,maxTotalChainCombos:100000,
  nearTransferMetres:0,costoAttesaOra:0,strict:true};
const log=(name,x)=>console.log(`[${name}] ${JSON.stringify(x,null,2)}`);
const checks=[];
function check(name,fn){try{fn();checks.push({test:name,esito:'OK'});}catch(e){checks.push({test:name,esito:'ERRORE',dettaglio:e.message});}}
function chain(result){return result.candidati.find(c=>c.missioni===2 && c.richieste.flat().join(',')==='101,102');}
async function run(label,requests,vehicle=base,options={}) {
  const result=await generaCandidatiFlotta({requests,nodes,vehicles:[vehicle],road}, {...opts,...options});
  log(`CONCAT_${label}`,{
    diagnostica:result.diagnostica,
    candidati:result.candidati.map(c=>({veicolo:c.veicolo,richieste:c.richieste,
      missioni:c.missioni,tipo:c.tipo_candidato,km_totali:c.km_totali,
      ricavo_euro:c.ricavo_euro,costo_completo_euro:c.costo_completo_euro,
      costo_attesa_euro:c.costo_attesa_euro,margine_ciclo_con_attesa_euro:c.margine_ciclo_con_attesa_euro,
      partenza_base:c.partenza_base,ritorno_base:c.ritorno_base,dettaglio_missioni:c.dettaglio_missioni})),
    utilizzabiliPerAttivazione:result.utilizzabiliPerAttivazione
  });
  return result;
}
let fatal=null;
try {
  const positive=await run('POSITIVO',[r1,r2]);
  const c=chain(positive);
  check('due missioni concatenate',()=>assert.ok(c,'nessun candidato con due missioni'));
  check('una catena costruita',()=>assert.ok(positive.diagnostica.catene>=1));
  check('percorso completo 29 km (3+10+2+10+4)',()=>assert.equal(c?.km_totali,29));
  check('ricavo lordo somma delle richieste 60 euro',()=>assert.equal(c?.ricavo_euro,60));
  check('costo intero ciclo 29 euro',()=>assert.equal(c?.costo_completo_euro,29));
  check('commissione 15% e margine netto 22 euro',()=>assert.equal(c?.margine_ciclo_con_attesa_euro,22));
  check('partenza dalla base ore 09:54',()=>sameInstant(c?.partenza_base,at('09:54')));
  check('ritorno alla base ore 11:08',()=>sameInstant(c?.ritorno_base,at('11:08')));
  check('nessuna certificazione produttiva senza validatori',()=>assert.equal(positive.utilizzabiliPerAttivazione,false));
  check('routing deterministico senza errori',()=>assert.equal(positive.diagnostica.routingErrori.length,0));

  const tooSoon=await run('TRASFERIMENTO_IMPOSSIBILE',[r1,{...r2,start_datetime:at('10:23')}]);
  check('trasferimento impossibile: nessuna catena',()=>assert.equal(tooSoon.diagnostica.catene,0));
  const tooLate=await run('ATTESA_ECCESSIVA',[r1,{...r2,start_datetime:at('14:00')}],base,{maxWaitMin:30});
  check('attesa eccessiva: nessuna catena',()=>assert.equal(tooLate.diagnostica.catene,0));
  const capacity=await run('CAPACITA_INSUFFICIENTE',[r1,r2],{...base,posti_totali:1});
  check('posti insufficienti: nessun candidato',()=>assert.equal(capacity.candidati.length,0));
  const underpriced=await run('SOTTO_SOGLIA',[{...r1,prezzo:10},{...r2,prezzo:10}]);
  check('ricavo lordo 20 euro sotto soglia: nessuna catena redditizia',()=>assert.equal(chain(underpriced),undefined));
  const noReturn=await run('RITORNO_INCLUSO',[{...r1,prezzo:16},{...r2,prezzo:16}]);
  // 32 euro lordi: dopo commissione 27,20, sotto il costo 29 (ma sopra 25 senza ritorno).
  check('ritorno alla base determinante per il filtro economico',()=>assert.equal(chain(noReturn),undefined));
} catch(e) {fatal=String(e.stack||e);}
const passed=checks.filter(x=>x.esito==='OK').length;
log('CONCAT_RIEPILOGO',{passati:passed,totali:checks.length,falliti:checks.filter(x=>x.esito!=='OK'),
  roadCalls,fatal,modalita:'SHADOW_NO_DB',nessuna_attivazione:true,
  nota:'Il test certifica soltanto i casi sintetici e le condizioni osservate, non la validazione produttiva.'});
if(fatal||passed!==checks.length)process.exitCode=1;
