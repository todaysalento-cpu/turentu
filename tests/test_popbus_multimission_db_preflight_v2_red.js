// TURENTU P0-C2 — RED preflight DB multimissione V1/V2 (PostgreSQL MOCK).
// Salvare in tests/test_popbus_multimission_db_preflight_v2_red.js
// Nessun DB reale, INSERT, worker, LIVE o pagamento.
import assert from 'node:assert/strict';
import { verificaMissioniPersistite } from '../services/popbus/v2/popbus-multimission-db-preflight.js';

const copy = v => structuredClone(v);
const departure = Date.parse('2027-04-01T10:00:00Z');
const coords = {5:[40.121583,18.305914],6:[40.12584865,18.29992067],14:[40.121583,18.305914],15:[40.12584865,18.29992067]};
function fixture(v2) {
  const nodes = v2 ? [14,14,15,15,15,15,14,14] : [5,6,6,5];
  const seconds = v2 ? [50,138,50,50,50,139,50] : [138,50,139];
  const metres = v2 ? [0,869,0,0,0,882,0] : [869,0,882];
  const legs = seconds.map((seconds,i)=>({seconds,metres:metres[i],polyline:'encoded-test-route'}));
  const times=[0];for(const s of seconds)times.push(times.at(-1)+s*1000);
  const ranges=v2?[[0,3],[4,7]]:[[0,1],[2,3]];
  const missioni=ranges.map(([startIndex,endIndex],i)=>({
    ordine:i+1,startIndex,endIndex,
    partenza:departure+times[startIndex],arrivo:departure+times[endIndex],
    ...(v2?{schemaVersion:2,tipoItinerario:'FERMATE_FISICHE',
      nodiTerritoriali:i===0?[5,6]:[6,5],pixelOpportunitaId:501+i,
      pixelDirettriceId:601+i,pixelVersione:3+i,corridoioPixelId:`pixel-engine-${i+1}`}:{})
  }));
  const piano={tipoPiano:'CICLO_PIXEL_CORSA_UNICA_V1',
    ...(v2?{schemaVersion:2,tipoItinerario:'FERMATE_FISICHE'}:{}),
    veicoloId:70,nodes,legs,
    coordinates:nodes.map(id=>({id,lat:coords[id][0],lon:coords[id][1]})),
    busyStart:new Date(departure-60000).toISOString(),
    busyEnd:new Date(departure+times.at(-1)+60000).toISOString(),
    missioni,evaluation:{departure,arrival:departure+times.at(-1),times,
      requests:ranges.map(([start,end],i)=>({id:900001+i,start,end}))}};
  const dbMissioni=ranges.map(([start,end],i)=>{
    const m=missioni[i],territorial=v2?m.nodiTerritoriali:nodes.slice(start,end+1);
    return {id:8101+i,ordine:i+1,direttrice_id:null,
      corridoio_pixel_id:v2?m.corridoioPixelId:null,
      pixel_opportunita_id:v2?m.pixelOpportunitaId:null,
      nodi_territoriali:copy(territorial),
      partenza:new Date(m.partenza),arrivo:new Date(m.arrivo),
      piano:{...(v2?{schemaVersion:2,tipoItinerario:'FERMATE_FISICHE'}:{}),
        nodes:copy(nodes.slice(start,end+1)),legs:copy(legs.slice(start,end)),
        requests:[{id:900001+i,start:0,end:end-start}],
        ...(v2?{pixel:{opportunitaId:m.pixelOpportunitaId,direttriceId:m.pixelDirettriceId,
          versione:m.pixelVersione,engineId:m.corridoioPixelId,nodiTerritoriali:copy(territorial)}}:{})}
    };
  });
  const locali=ranges.map((r,i)=>({missione_id:8101+i,richiesta_id:900001+i,indice_salita:0,indice_discesa:r[1]-r[0]}));
  const globali=ranges.map(([start,end],i)=>({richiesta_id:900001+i,indice_salita:start,indice_discesa:end,attiva:true}));
  const richieste=ranges.map((r,i)=>({id:900001+i,posti_richiesti:1,stato:'in_lavorazione',corsa_id:null}));
  return {piano,dbMissioni,locali,globali,richieste};
}
function mockDB(f) {
  const calls=[];
  return {calls,async query(sql,params) {
    const q=sql.replace(/\s+/g,' ').toLowerCase().trim();calls.push(q);
    if(/\b(insert|update|delete)\s/.test(q) && !q.startsWith('select '))throw Error('MOCK: SQL scrittura vietato');
    if(q.includes('from public.popbus_attivazione_missioni')&&!q.includes('join'))return {rows:copy(f.dbMissioni)};
    if(q.includes('from public.popbus_missione_richieste'))return {rows:copy(f.locali)};
    if(q.includes('from public.popbus_attivazione_richieste'))return {rows:copy(f.globali)};
    if(q.includes('from public.richieste_pop_bus'))return {rows:copy(f.richieste)};
    throw Error('MOCK: query imprevista: '+q.slice(0,160));
  }};
}
let pass=0,fail=0;
async function positive(name,v2){
  const f=fixture(v2),db=mockDB(f);
  try{
    const r=await verificaMissioniPersistite(db,{attivazioneId:7001,piano:f.piano,veicoloId:70,postiTotali:4});
    assert.equal(r.missioniPersistite,2);assert.equal(r.richiesteVerificate,2);assert.equal(r.peak,1);
    pass++;console.log('PASS POS - '+name);
  }catch(e){fail++;console.log('RED POS - '+name+': '+e.message);}
}
async function negative(name,mutate){
  const f=fixture(true),db=mockDB(f);mutate(f);
  try{
    await verificaMissioniPersistite(db,{attivazioneId:7001,piano:f.piano,veicoloId:70,postiTotali:4});
    fail++;console.log('RED NEG - '+name+': manomissione ACCETTATA');
  }catch(e){
    if(e.message.startsWith('MOCK:')){fail++;console.log('FAIL MOCK - '+name+': '+e.message);}
    else {pass++;console.log('PASS NEG - '+name+': '+e.message);}
  }
}
console.log('=== TURENTU — PREFLIGHT DB MULTIMISSIONE V1/V2 MOCK RED ===');
await positive('V1 territoriale',false);
await positive('V2 fermate fisiche e nodi PIXEL',true);
await negative('nodi territoriali persistiti alterati',f=>{f.dbMissioni[0].nodi_territoriali[1]=99;});
await negative('fermata fisica persistita alterata',f=>{f.dbMissioni[0].piano.nodes[2]=99;});
await negative('tratta fisica persistita alterata',f=>{f.dbMissioni[0].piano.legs[1].metres+=10;});
await negative('engine ID persistito alterato',f=>{f.dbMissioni[0].corridoio_pixel_id='alterato';});
await negative('versione PIXEL persistita alterata',f=>{f.dbMissioni[0].piano.pixel.versione=99;});
await negative('opportunita PIXEL persistita alterata',f=>{f.dbMissioni[0].pixel_opportunita_id=999;});
await negative('nodi PIXEL nel JSON alterati',f=>{f.dbMissioni[0].piano.pixel.nodiTerritoriali=[5,99];});
await negative('marker fisico JSON persistito assente',f=>{delete f.dbMissioni[0].piano.tipoItinerario;});
await negative('direttrice legacy persistita',f=>{f.dbMissioni[0].direttrice_id=88;});
await negative('mapping locale alterato',f=>{f.locali[0].indice_discesa=1;});
await negative('mapping globale alterato',f=>{f.globali[0].indice_discesa=1;});
await negative('richiesta DB non disponibile',f=>{f.richieste[0].stato='in_attesa';});
await negative('capienza DB superata',f=>{f.richieste[0].posti_richiesti=5;});
console.log(`\nRISULTATO: ${pass} PASS, ${fail} RED/FAIL. PostgreSQL mock; DB reale 0 scritture; LIVE NO.`);
if(fail)process.exitCode=1;
