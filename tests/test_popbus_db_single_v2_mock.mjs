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
const f=fixture(true);f.piano.nodes=f.piano.nodes.slice(0,4);f.piano.legs=f.piano.legs.slice(0,3);f.piano.coordinates=f.piano.coordinates.slice(0,4);f.piano.missioni=f.piano.missioni.slice(0,1);f.piano.evaluation.times=f.piano.evaluation.times.slice(0,4);f.piano.evaluation.arrival=f.piano.evaluation.departure+f.piano.evaluation.times.at(-1);f.piano.evaluation.requests=f.piano.evaluation.requests.slice(0,1);f.dbMissioni=f.dbMissioni.slice(0,1);f.locali=f.locali.slice(0,1);f.globali=f.globali.slice(0,1);f.richieste=f.richieste.slice(0,1);f.piano.busyEnd=new Date(f.piano.evaluation.arrival+60000).toISOString();const r=await verificaMissioniPersistite(mockDB(f),{attivazioneId:7001,piano:f.piano,veicoloId:70,postiTotali:4});assert.equal(r.missioniPersistite,1);assert.equal(r.richiesteVerificate,1);assert.equal(r.peak,1);console.log(12345);const bad=structuredClone(f);bad.dbMissioni[0].piano.pixel.versione=999;await assert.rejects(verificaMissioniPersistite(mockDB(bad),{attivazioneId:7001,piano:bad.piano,veicoloId:70,postiTotali:4}),/identita\/versione PIXEL persistita discordante/);console.log('DB_SINGLE_NEGATIVE PASS');