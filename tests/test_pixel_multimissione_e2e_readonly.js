// TURENTU — E2E puro PIXEL -> POPBUS, nessuna query/scrittura.
// Copiare in tests/test_pixel_multimissione_e2e_readonly.js e lanciare con node.
import assert from 'node:assert/strict';
import { diagnosticaCicloPixelPopbus } from '../services/pixel/pixel-popbus-cycle-adapter.js';
import { componiCicloInCorsa } from '../services/popbus/v2/popbus-single-corsa-assembler.js';
import { ottimizzaFlotta } from '../services/popbus/v2/fleet-optimizer.js';

const t = s => Date.parse(s);
const nodes = [{id:1,lat:40.1,lon:18.1},{id:2,lat:40.3,lon:18.3}];
const leg = {metres:30000,seconds:1800,polyline:'_p~iF~ps|U_ulLnnqC_mqNvxq`@'};
const corridors = new Map([
  [101,{nodes:[1,2],legs:[leg],richiestaIds:[501]}],
  [102,{nodes:[2,1],legs:[leg],richiestaIds:[502]}]
]);
const richieste = [
  {id:501,start_node_id:1,end_node_id:2,start_datetime:'2027-01-10T12:00:00Z',posti_richiesti:1,prezzo:45,distanza_diretta_km:30},
  {id:502,start_node_id:2,end_node_id:1,start_datetime:'2027-01-10T13:00:00Z',posti_richiesti:1,prezzo:45,distanza_diretta_km:30}
];
const byRequest = new Map(richieste.map(r=>[r.id,r]));
const engine = {getCorridor:id=>corridors.get(id),getRequest:id=>byRequest.get(id)};
const vehicle = {id:361,driver_id:999,posti_totali:4,euro_km:1,lat:nodes[0].lat,lon:nodes[0].lon};
const road = async (a,b) => a.lat===b.lat && a.lon===b.lon
  ? {metres:0,seconds:0,roadCoincident:true}
  : {...leg};
const common = {engine,richieste,vehicle,nodes,road,now:t('2026-12-01T00:00:00Z'),
  validateVehicle:async()=>true,validateCandidate:async()=>true};
let passed=0;
function check(label,condition){assert.ok(condition,label);console.log('PASS',label);passed++;}
const a=await diagnosticaCicloPixelPopbus({...common,missioni:[{corridorId:101,requestIds:[501]}]});
const b=await diagnosticaCicloPixelPopbus({...common,missioni:[{corridorId:102,requestIds:[502]}]});
check('andata isolata sotto soglia',a.motivo==='ECONOMIA_NETTA_INSUFFICIENTE');
check('ritorno isolato sotto soglia',b.motivo==='ECONOMIA_NETTA_INSUFFICIENTE');
const both=await diagnosticaCicloPixelPopbus({...common,missioni:[{corridorId:101,requestIds:[501]},{corridorId:102,requestIds:[502]}]});
check('ciclo A/R supera soglia economica',both.ok && both.economia.economicamenteAttivabile);
check('ciclo con validatori preliminari',both.validazionePreliminare===true);
check('trasferimento e attesa coerenti',both.trasferimenti.length===1 && both.trasferimenti[0].attesaMinuti===30);
check('ricavi di entrambe le richieste',both.economia.ricavoLordoEuro===90);
const assembled=componiCicloInCorsa({missioni:both.missioni,trasferimenti:both.trasferimenti,
  nodi:nodes,veicoloId:vehicle.id,busyStart:both.busyStart,busyEnd:both.busyEnd,
  approach:both.approach,returnTrip:both.returnTrip,postiTotali:vehicle.posti_totali});
check('assembler produce una corsa con due missioni',assembled.missioni.length===2 && assembled.tipoPiano==='CICLO_PIXEL_CORSA_UNICA_V1');
check('richieste conservate senza duplicati',assembled.evaluation.requests.map(r=>r.id).sort().join(',')==='501,502');
check('capienza per segmento verificata',assembled.validazioneCapienza.verificata && assembled.validazioneCapienza.peak===1);
check('assembler non autorizza attivazione',assembled.attivabile===false);
const candidate={veicolo:vehicle.id,richieste:both.richieste,partenza_base:both.busyStart,
  ritorno_base:both.busyEnd,margine_ciclo_con_attesa_euro:both.economia.margineEuro};
const optimal=ottimizzaFlotta([candidate]);
check('ottimizzatore globale seleziona ciclo',optimal.cicliSelezionati===1 && optimal.richiesteCoperte===2);
const duplicate=await diagnosticaCicloPixelPopbus({...common,missioni:[{corridorId:101,requestIds:[501]},{corridorId:102,requestIds:[501]}]});
check('duplicazione richiesta rifiutata',duplicate.motivo==='RICHIESTA_DUPLICATA');
const impossible=await diagnosticaCicloPixelPopbus({...common,
  richieste:[richieste[0],{...richieste[1],start_datetime:'2027-01-10T12:15:00Z'}],
  engine:{...engine,getRequest:id=>id===502?{...richieste[1],start_datetime:'2027-01-10T12:15:00Z'}:byRequest.get(id)},
  missioni:[{corridorId:101,requestIds:[501]},{corridorId:102,requestIds:[502]}]});
check('sequenza temporalmente impossibile rifiutata',!impossible.ok);
console.log('PIXEL_MULTIMISSIONE_E2E_READONLY_JSON:'+JSON.stringify({passed:true,test:passed,dbWrites:0,
  ricavoLordoEuro:both.economia.ricavoLordoEuro,margineEuro:both.economia.margineEuro,
  nota:'Fixture sintetica: non certifica PIXEL DB, turni reali, routing reale, pagamenti o commit'}));
