// TURENTU POPBUS / PIXEL — TEST 5, CICLI 1-2-3 MISSIONI — SOLA LETTURA
// Posizionare in tests/test_pixel_popbus_cicli_1_2_3_readonly.mjs
// Richiede gli adapter reali del progetto; non importa worker, pool o planner.
import { diagnosticaCicloPixelPopbus } from '../services/pixel/pixel-popbus-cycle-adapter.js';
import { valutaEconomiaCiclo } from '../services/popbus/v2/cycle-pricing.js';

const BASE=Date.parse('2030-04-01T10:00:00Z');
const iso=min=>new Date(BASE+min*60000).toISOString();
const nodes=Array.from({length:8},(_,i)=>({id:i+1,lat:40,lon:18+(i+1)*0.01}));
const node=id=>nodes.find(n=>n.id===id);
const leg=(a,b)=>({metres:Math.abs(a-b)*5000,seconds:Math.abs(a-b)*360,
  polyline:`mock-${a}-${b}`});
const road=async(a,b)=>leg(Math.round((a.lon-18)/0.01),Math.round((b.lon-18)/0.01));
const corridors=new Map([[1,{id:1,nodes:[1,2],legs:[leg(1,2)],richiestaIds:[1]}],
  [2,{id:2,nodes:[3,4],legs:[leg(3,4)],richiestaIds:[2]}],
  [3,{id:3,nodes:[5,6],legs:[leg(5,6)],richiestaIds:[3]}]]);
const makeRequest=(id,a,b,minute,prezzo=25)=>({id,start_node_id:a,end_node_id:b,
  start_datetime:iso(minute),posti_richiesti:1,prezzo,classe:'STANDARD',
  classe_percorrenza:'BASSA',max_fermate_intermedie:10,min_km_tra_fermate:0,
  max_deviazione_pct:100});
const requests=[makeRequest(1,1,2,0),makeRequest(2,3,4,60),makeRequest(3,5,6,120)];
const vehicle={id:1001,driver_id:501,posti_totali:8,euro_km:0.5,lat:node(1).lat,lon:node(1).lon};
const engine={getCorridor:id=>corridors.get(Number(id)),getRequest:id=>requests.find(r=>r.id===Number(id))};
const mission=(id)=>({corridorId:id,requestIds:[id]});
const checks=[];
const check=(name,condition,detail)=>checks.push({test:name,pass:Boolean(condition),...(detail?{detail}:{})});
const summarize=r=>({ok:r.ok,motivo:r.motivo??null,attivabile:r.attivabile,
  validazionePreliminare:r.validazionePreliminare??false,
  numeroMissioni:r.missioni?.length??0,richieste:r.richieste??[],
  trasferimenti:r.trasferimenti??[],busyStart:r.busyStart??null,busyEnd:r.busyEnd??null,
  economia:r.economia?{km:r.economia.km,ricavoLordoEuro:r.economia.ricavoLordoEuro,
    commissioneTurentuEuro:r.economia.commissioneTurentuEuro,
    costoCompletoEuro:r.economia.costoCompletoEuro,margineEuro:r.economia.margineEuro,
    economicamenteAttivabile:r.economia.economicamenteAttivabile}:null});
const run=(ids,overrides={})=>diagnosticaCicloPixelPopbus({engine,
  missioni:ids.map(mission),richieste:requests,vehicle,nodes,road,
  now:Date.parse('2029-01-01T00:00:00Z'),maxWaitMin:180,
  costoAttesaOraEuro:2,
  validateVehicle:async()=>true,validateCandidate:async()=>true,...overrides});

const one=await run([1]),two=await run([1,2]),three=await run([1,2,3]);
for(const [name,result,count] of [['UNA',one,1],['DUE',two,2],['TRE',three,3]]){
  check(`${name}: diagnostica valida ma non attivabile`,result.ok===true&&result.attivabile===false);
  check(`${name}: numero missioni corretto`,result.missioni?.length===count);
  check(`${name}: validazioni preliminari complete`,result.validazionePreliminare===true);
  check(`${name}: economia positiva`,result.economia?.economicamenteAttivabile===true);
  check(`${name}: richieste senza duplicati`,new Set(result.richieste??[]).size===count);
}
check('Due missioni: un trasferimento',two.trasferimenti?.length===1);
check('Tre missioni: due trasferimenti',three.trasferimenti?.length===2);
check('Tre missioni: km trasferimenti = 10',three.economia?.km?.trasferimenti===10);
check('Tre missioni: ritorno base = 25 km',three.economia?.km?.ritornoBase===25);
check('Tre missioni: avvicinamento = 0 km',three.economia?.km?.avvicinamento===0);
check('Tre missioni: km missioni = 15',three.economia?.km?.missioni===15);
check('Tre missioni: km totali = 50',three.economia?.km?.totali===50);
check('Tre missioni: commissione 15%',three.economia?.centesimi?.commissione===1125);

// Controfattuale: eseguire ogni missione come ciclo autonomo con lo stesso mezzo
// richiede ogni volta avvicinamento dalla base e ritorno alla base.
const standalone=await Promise.all([1,2,3].map(id=>run([id])));
const separateKm=standalone.reduce((s,r)=>s+(r.economia?.km?.totali??0),0);
const chainedKm=three.economia?.km?.totali??null;
check('Catena: meno km rispetto a tre cicli autonomi',chainedKm!==null&&chainedKm<separateKm);
const standaloneCost=standalone.reduce((s,r)=>s+(r.economia?.centesimi?.costoCompleto??0),0);
check('Catena: costo completo inferiore ai tre cicli',three.economia?.centesimi?.costoCompleto<standaloneCost);

// Prove negative: mutate soltanto le fixture locali, non il database.
const original2=requests[1];
requests[1]=makeRequest(2,3,4,3);
const impossible=await run([1,2]);
requests[1]=original2;
check('Trasferimento impossibile rifiutato',impossible.ok===false&&impossible.motivo==='TRASFERIMENTO_TEMPORALMENTE_IMPOSSIBILE',impossible.motivo);
requests[1]=makeRequest(2,3,4,400);
const tooLong=await run([1,2]);
requests[1]=original2;
check('Attesa eccessiva rifiutata',tooLong.ok===false&&tooLong.motivo==='ATTESA_ECCESSIVA',tooLong.motivo);
const duplicate=await run([1,1]);
check('Richiesta duplicata rifiutata',duplicate.ok===false&&duplicate.motivo==='RICHIESTA_DUPLICATA',duplicate.motivo);
const four=await run([1,2,3,1]);
check('Quattro missioni non supportate',four.ok===false&&four.motivo==='NUMERO_MISSIONI_NON_SUPPORTATO',four.motivo);
const vehicleDenied=await run([1,2],{validateVehicle:async()=>false});
check('Veicolo indisponibile rifiutato',vehicleDenied.ok===false&&vehicleDenied.motivo==='VEICOLO_NON_DISPONIBILE',vehicleDenied.motivo);
const commercialDenied=await run([1,2],{validateCandidate:async()=>false});
check('Regole commerciali rifiutate',commercialDenied.ok===false&&commercialDenied.motivo==='REGOLE_COMMERCIALI_NON_SUPERATE',commercialDenied.motivo);
const poorRequests=requests.map(r=>({...r,prezzo:1}));
const poor=await run([1,2,3],{richieste:poorRequests});
check('Ciclo antieconomico rifiutato',poor.ok===false&&poor.motivo==='ECONOMIA_NETTA_INSUFFICIENTE',poor.motivo);
const noValidators=await run([1,2,3],{validateVehicle:undefined,validateCandidate:undefined});
check('Senza callback: nessuna validazione preliminare certificata',noValidators.ok===true&&noValidators.validazionePreliminare===false);
check('Nessun caso produce attivazione', [one,two,three,impossible,tooLong,duplicate,four,vehicleDenied,commercialDenied,poor,noValidators].every(r=>r.attivabile===false));

// Due mezzi dello stesso titolare: la fixture non applica blocchi per driver_id.
const secondVehicle={...vehicle,id:1002};
const parallel=await run([1],{vehicle:secondVehicle});
check('Mezzi distinti stesso titolare: diagnostiche indipendenti',parallel.ok===true&&one.ok===true&&parallel.veicoloId!==one.veicoloId&&parallel.titolareId===one.titolareId);

const report={test:'TURENTU TEST 5 — CICLI PIXEL/POPBUS 1-2-3 MISSIONI',
  modalita:'SOLA LETTURA — adapter reale, routing MOCK, disponibilita simulata',
  avvertenze:[
    'I corridoi sono fixture controllate: questo test non verifica la generazione di PIXEL.',
    'Usa diagnosticaCicloPixelPopbus e valutaEconomiaCiclo reali; non importa worker/DB.',
    'Nessuna attivazione reale: attivabile deve restare false.',
    'Non verifica ottimizzazione globale, transazioni, turni autisti o routing stradale reale.',
    'La comparazione con tre cicli autonomi e un controfattuale economico, non una schedulazione di tre viaggi sullo stesso mezzo.'
  ],
  cicli:{unaMissione:summarize(one),dueMissioni:summarize(two),treMissioni:summarize(three)},
  confronto:{kmTreCicliAutonomi:separateKm,kmCicloConcatenato:chainedKm,
    kmRisparmiati:separateKm-chainedKm,
    costoTreCicliAutonomiEuro:standaloneCost/100,
    costoCicloConcatenatoEuro:(three.economia?.centesimi?.costoCompleto??0)/100,
    risparmioCostiEuro:(standaloneCost-(three.economia?.centesimi?.costoCompleto??0))/100},
  casiNegativi:{trasferimentoImpossibile:impossible.motivo,attesaEccessiva:tooLong.motivo,
    duplicato:duplicate.motivo,quattroMissioni:four.motivo,
    veicoloIndisponibile:vehicleDenied.motivo,regoleCommerciali:commercialDenied.motivo,
    economiaInsufficiente:poor.motivo},
  checks,passed:checks.filter(x=>x.pass).length,failed:checks.filter(x=>!x.pass).length};
console.log(JSON.stringify(report,null,2));
if(report.failed)process.exitCode=1;
