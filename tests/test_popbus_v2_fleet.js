// TURENTU POPBUS V2 — TEST INTEGRAZIONE FLEET (SOLO IN MEMORIA)
// Salva come tests/test_popbus_v2_fleet.js
// Esegui dalla root: node tests\test_popbus_v2_fleet.js
// Nessun DB, Google Maps, pagamento, socket, scrittura o worker.
// NON confronta automaticamente il margine 171,20 EUR del Test 10B:
// per quel confronto servono gli stessi candidati reali e gli stessi filtri.

import assert from 'node:assert/strict';
import { generaCandidatiFlotta } from '../services/popbus/v2/fleet-candidates.js';
import { ottimizzaFlotta } from '../services/popbus/v2/fleet-optimizer.js';

const log = (name, data) => console.log(`[${name}] ${JSON.stringify(data, null, 2)}`);
const N = [
  {id:1,lat:40.0,lon:18.0},
  {id:2,lat:40.1,lon:18.0},
  {id:3,lat:40.2,lon:18.0}
];
const V = [
  {id:101,lat:40.0,lon:18.0,posti_totali:4,euro_km:0.5},
  {id:102,lat:40.0,lon:18.0,posti_totali:2,euro_km:0.5}
];
const R = [
  {id:1,start_node_id:1,end_node_id:2,start_datetime:'2030-01-01T10:00:00Z',posti_richiesti:1,prezzo:30,classe:'STANDARD'},
  {id:2,start_node_id:1,end_node_id:2,start_datetime:'2030-01-01T10:00:00Z',posti_richiesti:1,prezzo:20,classe:'STANDARD'},
  {id:3,start_node_id:2,end_node_id:1,start_datetime:'2030-01-01T11:00:00Z',posti_richiesti:1,prezzo:25,classe:'STANDARD'}
];
const METRES_PER_HOP=10000;
const SECONDS_PER_HOP=1200;
let routeCalls=0;
async function fakeRoad(a,b) {
  routeCalls++;
  const delta=Math.abs(Number(a.lat)-Number(b.lat));
  const hops=Math.round(delta/0.1);
  assert.ok(Math.abs(delta-hops*0.1)<1e-8, 'Fixture geometrica inattesa');
  if(!hops)return {metres:0,seconds:0};
  return {metres:hops*METRES_PER_HOP,seconds:hops*SECONDS_PER_HOP};
}
const common={
  requests:R,nodes:N,vehicles:V,road:fakeRoad
};
const opts={now:Date.parse('2029-12-31T00:00:00Z'),maxWaitMin:180,
  maxChains:100,maxFormations:100,maxAggregateCombos:100,
  maxCombosPerChainVehicle:100,maxTotalChainCombos:1000,
  nearTransferMetres:0};

function checkSelected(result) {
  const used=new Set(),byVehicle=new Map();
  for(const c of result.selezionati){
    for(const id of c.richieste.flat()) {
      assert.ok(!used.has(id),`Richiesta duplicata ${id}`);
      used.add(id);
    }
    const list=byVehicle.get(c.veicolo)||[];
    const a=Date.parse(c.partenza_base),b=Date.parse(c.ritorno_base);
    for(const [x,y] of list) assert.ok(b<=x||a>=y,'Cicli sovrapposti');
    list.push([a,b]);byVehicle.set(c.veicolo,list);
  }
}
async function run() {
  // 1. Test puro ottimizzatore: optimum B+C = 16, non A+C = 15.
  const t=(id,vehicle,req,start,end,margin)=>({
    id,veicolo:vehicle,richieste:[[req]],
    partenza_base:`2030-01-01T${start}:00Z`,
    ritorno_base:`2030-01-01T${end}:00Z`,
    margine_ciclo_con_attesa_euro:margin
  });
  const synthetic=[
    t('A',1,9001,'10:00','11:00',10),
    t('B',2,9001,'10:00','11:00',11),
    t('C',1,9002,'11:00','12:00',5)
  ];
  const o=ottimizzaFlotta(synthetic);
  assert.equal(o.margineTotaleEuro,16);
  assert.equal(o.cicliSelezionati,2);
  assert.equal(o.ottimoSulCampione,true);
  assert.deepEqual(o.selezionati.map(x=>x.id).sort(),['B','C']);
  checkSelected(o);
  log('TEST_1_OPTIMIZER',{esito:'OK',margine:o.margineTotaleEuro,cicli:o.cicliSelezionati});

  // 2. Senza validatori: i candidati sono SOLO diagnostici.
  const raw=await generaCandidatiFlotta(common,opts);
  assert.ok(raw.candidati.length>0);
  assert.equal(raw.utilizzabiliPerAttivazione,false);
  assert.equal(raw.diagnostica.prontoPerOttimizzazioneProduttiva,false);
  assert.ok(raw.candidati.some(x=>x.missioni===2),'Nessuna catena generata');
  assert.ok(raw.candidati.some(x=>x.missioni===1),'Nessuna singola generata');
  for(const x of raw.candidati){
    assert.equal(x.validazione_preliminare,false);
    assert.ok(x.costo_completo_euro>=0);
    assert.ok(x.margine_ciclo_con_attesa_euro>0);
    const ids=x.richieste.flat();
    assert.equal(ids.length,new Set(ids).size);
  }
  const best=ottimizzaFlotta(raw.candidati);
  checkSelected(best);
  log('TEST_2_GENERATORE_SHADOW',{
    esito:'OK',missioni:raw.diagnostica.missioni,
    catene:raw.diagnostica.catene,candidati:raw.candidati.length,
    margineOttimizzato:best.margineTotaleEuro,
    ottimoSulCampione:best.ottimoSulCampione,
    attivabile:false
  });

  // 3. Il costo di ritorno deve essere compreso nel costo del ciclo.
  const returnChain=raw.candidati.find(x=>x.veicolo===101 &&
    x.missioni===2 && x.richieste.flat().length===2 &&
    x.richieste.flat().includes(1) && x.richieste.flat().includes(3));
  assert.ok(returnChain,'Catena A->B->A non trovata');
  assert.equal(returnChain.km_totali,20);
  assert.equal(returnChain.costo_completo_euro,10);
  assert.equal(returnChain.ricavo_euro,55);
  assert.equal(returnChain.margine_ciclo_con_attesa_euro,45);
  // Singola A->B: 10km commerciali + 10km ritorno vuoto.
  const single=raw.candidati.find(x=>x.veicolo===101 && x.missioni===1 &&
    x.richieste.flat().length===1 && x.richieste[0][0]===1);
  assert.ok(single);
  assert.equal(single.km_totali,20);
  assert.equal(single.costo_completo_euro,10);
  log('TEST_3_COSTI_RITORNO',{esito:'OK',costoCatena:returnChain.costo_completo_euro,
    costoSingola:single.costo_completo_euro});

  // 4. I validatori sono invocati; la soglia e' SOLO una fixture.
  let vehicleChecks=0,candidateChecks=0;
  const validated=await generaCandidatiFlotta({
    ...common,
    validateVehicle:async (_v,a,b)=>{
      vehicleChecks++;
      return Number.isFinite(a)&&b>a;
    },
    validateCandidate:async (candidate)=>{
      candidateChecks++;
      // Simulazione DI TEST: non rappresenta le soglie reali di classe.
      // Usa costo_completo_euro, che INCLUDE ritorno alla base.
      return candidate.ricavo_euro>=candidate.costo_completo_euro*1.1;
    }
  },opts);
  assert.ok(vehicleChecks>0 && candidateChecks>0);
  assert.ok(validated.candidati.every(x=>x.validazione_preliminare));
  assert.equal(validated.utilizzabiliPerAttivazione,false);
  const vBest=ottimizzaFlotta(validated.candidati);
  checkSelected(vBest);
  log('TEST_4_VALIDATORI',{esito:'OK',vehicleChecks,candidateChecks,
    candidati:validated.candidati.length,attivabile:false});

  // 5. Il limite dell'ottimizzatore non deve essere presentato come ottimo.
  const cut=ottimizzaFlotta(synthetic,{maxNodi:1});
  assert.equal(cut.ottimoSulCampione,false);
  assert.equal(cut.limiteNodiRaggiunto,true);
  log('TEST_5_LIMITE',{esito:'OK',nodi:cut.nodiEsplorati,
    ottimoSulCampione:cut.ottimoSulCampione});

  // 6. Limite enumerazione: segnalazione esplicita.
  const limited=await generaCandidatiFlotta(common,{
    ...opts,maxFormations:1
  });
  assert.ok(limited.diagnostica.limiti.includes('MAX_FORMATIONS'));
  assert.equal(limited.diagnostica.enumerazioneSenzaTagli,false);
  log('TEST_6_ENUMERAZIONE',{esito:'OK',limiti:limited.diagnostica.limiti});

  log('VERDETTO_FLEET_TEST',{
    esito:'SUPERATO',test:6,routeCalls,
    nessunaScritturaDB:true,
    nessunaChiamataGoogle:true,
    workerNonModificato:true,
    confrontoCon171_20:'NON ESEGUITO: richiede dataset e validatori Test 10B',
    avvertenza:'I validatori reali di pagamenti, turni, qualita, conflitti, raggio e soglie devono ancora essere integrati.'
  });
}
run().catch(e=>{
  console.error('[TEST_FLEET_FALLITO]',e.stack||e.message);
  process.exitCode=1;
});
