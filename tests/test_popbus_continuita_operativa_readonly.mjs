// TURENTU TEST 12 — continuita' fisica, temporale ed economica di missioni concatenate.
// Sola lettura, fixture deterministiche; nessun DB, worker o modifica ai moduli produttivi.
import { performance } from 'node:perf_hooks';

const tests=[];
const check=(name,ok,details={})=>tests.push({test:name,pass:Boolean(ok),...details});
const nodes={BASE:{x:0},A:{x:10},B:{x:20},C:{x:24},D:{x:34},E:{x:50},F:{x:60},G:{x:12},H:{x:17}};
const SPEED_KMH=60, EURO_KM=0.8, COMMISSION_RATE=0.15, BUFFER_MIN=3;
const km=(a,b)=>Math.abs(nodes[a].x-nodes[b].x);
const minutes=(a,b)=>km(a,b)/SPEED_KMH*60;
const missions={
 M1:{id:'M1',from:'A',to:'B',start:10,end:20,revenue:40,reqIds:['R1']},
 M2:{id:'M2',from:'C',to:'D',start:30,end:40,revenue:45,reqIds:['R2']},
 M3:{id:'M3',from:'E',to:'F',start:43,end:53,revenue:55,reqIds:['R3']},
 M4:{id:'M4',from:'G',to:'H',start:31,end:36,revenue:22,reqIds:['R4']},
 M5:{id:'M5',from:'C',to:'D',start:25,end:35,revenue:45,reqIds:['R5']},
 M6:{id:'M6',from:'C',to:'D',start:26,end:36,revenue:45,reqIds:['R6']},
};
function evaluate(ids,{base='BASE',rate=EURO_KM,buffer=BUFFER_MIN}={}){
 const ms=ids.map(id=>missions[id]);if(ms.some(x=>!x))throw Error('Missione sconosciuta');
 let prev=base,previousEnd=0,totalKm=0,transferKm=0,passengerKm=0;
 const legs=[],reasons=[];const req=new Set();
 for(const m of ms){
  for(const r of m.reqIds){if(req.has(r))reasons.push('RICHIESTA_DUPLICATA');req.add(r)}
  const repositionKm=km(prev,m.from),repositionMin=minutes(prev,m.from);
  const earliest=previousEnd+repositionMin+(prev===base&&legs.length===0?0:buffer);
  const temporalOk=earliest<=m.start+1e-9;
  if(!temporalOk)reasons.push('RIPOSIZIONAMENTO_IMPOSSIBILE');
  const actualRideMin=minutes(m.from,m.to);
  if(m.end-m.start+1e-9<actualRideMin)reasons.push('DURATA_CORSA_INSUFFICIENTE');
  const rideKm=km(m.from,m.to);totalKm+=repositionKm+rideKm;transferKm+=repositionKm;passengerKm+=rideKm;
  legs.push({mission:m.id,from:prev,to:m.from,transferKm:repositionKm,transferMin:repositionMin,earliestStart:+earliest.toFixed(2),scheduledStart:m.start,temporalOk,rideKm});
  prev=m.to;previousEnd=m.end;
 }
 const returnKm=km(prev,base);totalKm+=returnKm;
 const gross=ms.reduce((s,m)=>s+m.revenue,0),commission=+((gross*COMMISSION_RATE)).toFixed(2);
 const cost=+(totalKm*rate).toFixed(2),margin=+(gross-commission-cost).toFixed(2);
 return {ids,feasible:reasons.length===0,reasons:[...new Set(reasons)],legs,passengerKm,transferKm,returnKm,totalKm,gross,commission,cost,margin,busyStart:legs.length?legs[0].earliestStart:0,busyEnd:previousEnd+minutes(prev,base)};
}
function standalone(ids){return ids.map(id=>evaluate([id]));}
const cases={
 feasibleChain:evaluate(['M1','M2']),
 impossibleTransfer:evaluate(['M1','M3']),
 temporalOverlap:evaluate(['M1','M5']),
 noBuffer:evaluate(['M1','M6'],{buffer:0}),
 withBuffer:evaluate(['M1','M6']),
 singleM1:evaluate(['M1']),singleM2:evaluate(['M2']),
 threeMissions:evaluate(['M1','M2','M3']),
};
// M1: BASE->A 10 km, A->B 10 km; B->C 4 km, C->D 10 km; D->BASE 34 km = 68 km.
check('Ciclo M1+M2 fisicamente e temporalmente valido',cases.feasibleChain.feasible);
check('Trasferimento B->C calcolato correttamente',cases.feasibleChain.legs[1].transferKm===4);
check('Un solo ritorno finale alla base',cases.feasibleChain.returnKm===34&&cases.feasibleChain.totalKm===68);
check('Ritorno intermedio non contabilizzato',cases.feasibleChain.totalKm<cases.singleM1.totalKm+cases.singleM2.totalKm);
check('Economia ciclo calcolata con commissione e costo effettivo',cases.feasibleChain.margin===+(85-85*.15-68*.8).toFixed(2));
check('Trasferimento lungo non fattibile rilevato',!cases.impossibleTransfer.feasible&&cases.impossibleTransfer.reasons.includes('RIPOSIZIONAMENTO_IMPOSSIBILE'));
check('Partenza sovrapposta non fattibile rilevata',!cases.temporalOverlap.feasible);
check('Buffer operativo incide sulla fattibilita',cases.noBuffer.feasible&&!cases.withBuffer.feasible);
check('Tre missioni non sono automaticamente valide',!cases.threeMissions.feasible);
const sameOwner=[{id:'V1',ownerId:700},{id:'V2',ownerId:700}];
const concurrent=[{vehicle:sameOwner[0],from:10,to:40},{vehicle:sameOwner[1],from:10,to:40}];
check('Veicoli distinti stesso titolare possono operare insieme',concurrent[0].vehicle.id!==concurrent[1].vehicle.id);
const conflicting=[{vehicleId:'V1',from:10,to:40},{vehicleId:'V1',from:30,to:50}];
check('Stesso veicolo con cicli sovrapposti e in conflitto',conflicting[0].from<conflicting[1].to&&conflicting[1].from<conflicting[0].to);
// Caso operativo: un trasferimento dopo il ritorno alla base puo' rendere impossibile la missione successiva.
const m1=cases.singleM1,m2=cases.singleM2;
const nextStart=missions.M2.start;
const backAtBase=missions.M1.end+minutes(missions.M1.to,'BASE');
const canDoSeparate=backAtBase+minutes('BASE',missions.M2.from)+BUFFER_MIN<=nextStart;
check('Ritorno alla base tra missioni non fattibile nel caso guida',!canDoSeparate&&cases.feasibleChain.feasible);
const marginSeparate=+(m1.margin+m2.margin).toFixed(2);
check('Concatenazione riduce i km rispetto ai cicli separati',cases.feasibleChain.totalKm<m1.totalKm+m2.totalKm);
check('Concatenazione migliora il margine rispetto ai due cicli separati',cases.feasibleChain.margin>marginSeparate);
// Controllo anti doppia contabilizzazione del ritorno: la somma dei cicli singoli NON e' il costo del ciclo concatenato.
check('Costi diversi tra concatenato e somma delle singole',cases.feasibleChain.cost!==+(m1.cost+m2.cost).toFixed(2));
const output={test:'TURENTU TEST 12 — CONTINUITA OPERATIVA ED ECONOMIA CICLI CONCATENATI',mode:'SOLA LETTURA, MOCK DETERMINISTICI',limits:['Fixture geometriche lineari e velocita costante; non routing stradale reale.','Non importa PIXEL, POPBUS, adapter o worker: e un oracolo indipendente per verificare regole operative.','Non verifica disponibilita autisti fisici, turni, DB, transazioni o normative.','L obiettivo e isolare bug di riposizionamento, tempo e ritorno base; non certificare l ottimo globale.'],settings:{speedKmh:SPEED_KMH,bufferMin:BUFFER_MIN,euroKm:EURO_KM,commissionRate:COMMISSION_RATE},cases,comparison:{separate:{km:m1.totalKm+m2.totalKm,cost:+(m1.cost+m2.cost).toFixed(2),margin:marginSeparate,canOperateSequentially:canDoSeparate},concatenated:{km:cases.feasibleChain.totalKm,cost:cases.feasibleChain.cost,margin:cases.feasibleChain.margin,feasible:cases.feasibleChain.feasible},savingsKm:m1.totalKm+m2.totalKm-cases.feasibleChain.totalKm,extraMargin:+(cases.feasibleChain.margin-marginSeparate).toFixed(2)},checks:tests,passed:tests.filter(t=>t.pass).length,failed:tests.filter(t=>!t.pass).length};
console.log(JSON.stringify(output,null,2));if(output.failed)process.exitCode=1;
