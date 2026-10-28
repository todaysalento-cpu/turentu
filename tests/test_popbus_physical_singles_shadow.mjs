// TURENTU POPBUS V2 - regressione missioni singole fisiche SHADOW.
// Salvare in tests/test_popbus_physical_singles_shadow.mjs
// Nessun database, nessuna attivazione LIVE.
import assert from 'node:assert/strict';
import { selezionaCicliFisiciShadow } from '../services/popbus/v2/popbus-physical-cycle-selector.js';

const NOW = Date.parse('2027-04-01T07:00:00.000Z');
const BASE = {lat:40.0,lon:18.0};
const STOP1 = {id:101,lat:40.1,lon:18.1};
const STOP2 = {id:102,lat:40.2,lon:18.2};
const vehicle = {id:7,...BASE,euro_km:1.5,posti_totali:4};
const candidate = (id,price=80,offset=0) => ({
  tipoItinerario:'FERMATE_FISICHE',schemaVersion:2,
  vehicleId:7,pixelOpportunitaId:id,corridoioPixelId:'corridor-test',
  from:{lat:STOP1.lat,lon:STOP1.lon},to:{lat:STOP2.lat,lon:STOP2.lon},
  departure:NOW+3600000+offset,arrival:NOW+5400000+offset,
  kmMissione:20,peak:1,
  requests:[{id,prezzo:price}],
  nodiFisici:[STOP1,STOP2],
  plan:{nodes:[101,102],legs:[{metres:20000,seconds:1800,polyline:'test-road'}]},
  evaluation:{requests:[{id,start:0,end:1,posti_richiesti:1}]}
});
let checks=0;
const pass = name => { checks++; console.log('PASS',name); };
const run = async ({candidati=[candidate(1)],validateSingle=async()=>true,
  available=async()=>true,conflict=async()=>false,price,
  includeCallback=true}={}) => {
  const routes=[];
  const result = await selezionaCicliFisiciShadow({
    candidati:price===undefined?candidati:[candidate(1,price)],vehicles:[vehicle],
    now:NOW,maxPairs:100,maxRoutingCalls:20,maxRisultati:10,
    movement:async(from,to)=>{
      routes.push([from,to]);
      const same=Number(from.lat)===Number(to.lat)&&Number(from.lon)===Number(to.lon);
      return {metres:same?0:5000,seconds:same?0:600};
    },
    isAvailable:available,hasConflicts:conflict,
    validatePair:async()=>true,
    ...(includeCallback?{validateSingle}:{})
  });
  assert.equal(result.shadow,true);
  assert.equal(result.attivabile,false);
  assert.equal(result.dbWrites,0);
  return {result,routes};
};

const positive=await run();
assert.equal(positive.result.diagnostica.singoleEsaminate,1);
assert.equal(positive.result.diagnostica.singoleFisicamenteFattibili,1);
assert.equal(positive.result.diagnostica.singoleEconomicamenteAmmissibili,1);
assert.equal(positive.result.migliorCiclo.missioni.length,1);
assert.deepEqual(positive.result.migliorCiclo.richiestaIds,[1]);
assert.equal(positive.result.migliorCiclo.economia.km.totali,30);
assert.equal(positive.result.migliorCiclo.economia.margineEuro,23);
assert.equal(positive.routes.length,2);
pass('singola sostenibile: 30 km inclusi avvicinamento e ritorno');

const negative=await run({price:30});
assert.equal(negative.result.diagnostica.singoleScartateEconomia,1);
assert.equal(negative.result.migliorCiclo,null);
pass('singola non sostenibile esclusa');

const unavailable=await run({available:async()=>false});
assert.equal(unavailable.result.diagnostica.singoleScartateOperativita,1);
assert.equal(unavailable.result.migliorCiclo,null);
pass('singola con veicolo non disponibile esclusa');

const conflicting=await run({conflict:async()=>true});
assert.equal(conflicting.result.diagnostica.singoleScartateOperativita,1);
assert.equal(conflicting.result.migliorCiclo,null);
pass('singola con conflitto esclusa');

const denied=await run({validateSingle:async()=>false});
assert.equal(denied.result.diagnostica.singoleScartateVincoli,1);
assert.equal(denied.result.migliorCiclo,null);
pass('singola con vincoli A/R o qualita non validati esclusa');

const noCallback=await run({includeCallback:false});
assert.equal(noCallback.result.diagnostica.singoleNonValutateSenzaCallback,true);
assert.equal(noCallback.result.diagnostica.singoleEsaminate,0);
assert.equal(noCallback.result.migliorCiclo,null);
pass('assenza callback: fail closed per le singole');

const pairOnly=await run({candidati:[candidate(1,80),candidate(2,80,7200000)],includeCallback:false});
assert.equal(pairOnly.result.diagnostica.singoleEsaminate,0);
assert.equal(pairOnly.result.diagnostica.coppieAmmesseDaVincoli,1);
assert.equal(pairOnly.result.diagnostica.cicliEconomicamenteAmmissibili,1);
assert.equal(pairOnly.result.migliorCiclo.missioni.length,2);
pass('regressione: coppia compatibile preservata');

console.log(`TEST PHYSICAL SINGLES SHADOW: ${checks} SCENARI SUPERATI, DB WRITES 0`);
