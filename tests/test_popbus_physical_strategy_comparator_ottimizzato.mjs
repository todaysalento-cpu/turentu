// Test sintetico SHADOW: nessun DB, nessuna attivazione.
import assert from 'node:assert/strict';
import { confrontaStrategieFisicheShadow } from '../services/popbus/v2/popbus-physical-strategy-comparator.js';
const now=1_000_000;
const s1={id:1,lat:40,lon:18},s2={id:2,lat:40.1,lon:18},s3={id:3,lat:40.2,lon:18};
function candidate(vehicleId,op,id,from,to,price=40){return {
  tipoItinerario:'FERMATE_FISICHE',schemaVersion:2,vehicleId,pixelOpportunitaId:op,
  from,to,departure:now+3600000,arrival:now+4200000,kmMissione:10,peak:1,
  requests:[{id,prezzo:price}],plan:{nodes:[from.id,to.id],legs:[{metres:10000,seconds:600}]},
  nodiFisici:[from,to],evaluation:{requests:[{id,start:0,end:1}]}
};}
const vehicles=[{id:1,lat:40,lon:18,euro_km:0.6,posti_totali:4},
  {id:2,lat:40.2,lon:18,euro_km:0.6,posti_totali:4}];
const selection={shadow:true,attivabile:false,dbWrites:0,diagnostica:{completo:true},miglioriCicli:[]};
const a=candidate(1,118,196,s1,s2), b=candidate(2,119,202,s2,s3);
let availability=0,conflicts=0,validation=0;
const common={candidati:[a,b],vehicles,now,
  movement:async()=>({metres:2000,seconds:200}),
  isAvailable:async()=>{availability++;return true;},
  hasConflicts:async()=>{conflicts++;return false;},
  validateSelection:async()=>{validation++;return true;},selezioneFisica:selection};
const result=await confrontaStrategieFisicheShadow(common);
assert.equal(result.miglioreCoppiaIndipendente.numeroRichieste,2);
assert.equal(result.diagnosticaEconomicaSingole.singoleAnalizzate,2);
assert.equal(result.diagnosticaEconomicaSingole.singoleEconomicamenteAmmissibili,2);
assert.equal(result.diagnostica.chiamateDisponibilita,availability);
assert.equal(result.diagnostica.chiamateConflitti,conflicts);
assert.equal(result.attivabile,false);assert.equal(result.dbWrites,0);assert.equal(result.offerte,0);
assert.ok(result.diagnostica.tempiMs.totale>=0);
const cheapA=candidate(1,118,196,s1,s2,1),cheapB=candidate(2,119,202,s2,s3,1);
validation=0;
const cheap=await confrontaStrategieFisicheShadow({...common,candidati:[cheapA,cheapB]});
assert.equal(cheap.miglioreSingola,null);
assert.equal(cheap.miglioreCoppiaIndipendente,null);
assert.equal(cheap.diagnosticaEconomicaSingole.singoleEconomicamenteInsufficienti,2);
assert.equal(cheap.diagnostica.coppieIndipendentiEsaminate,1);
assert.equal(cheap.diagnostica.scartiEconomia,3); // 2 singole + 1 coppia
assert.equal(validation,0); // filtro economico sicuro, senza chiamate A/R inutili
assert.ok(cheap.diagnosticaEconomicaSingole.esempiMigliori[0].kmVuoto>=0);
assert.ok(cheap.diagnosticaEconomicaSingole.perVeicolo.length===2);
console.log('POPBUS_STRATEGY_COMPARATOR_OPTIMIZED_SHADOW_OK');
console.log(JSON.stringify({diagnostica:cheap.diagnostica,diagnosticaEconomicaSingole:cheap.diagnosticaEconomicaSingole},null,2));
