// TURENTU — POPBUS cycle persistence V1/V2, test comportamentale RED.
// Copiare come tests/test_popbus_cycle_persistence_physical_mock_red.js
// Mock PostgreSQL in memoria: nessuna connessione o scrittura reale, LIVE NO.
import assert from 'node:assert/strict';
import { registraMissioniAttivazione } from '../services/popbus/v2/popbus-cycle-persistence.js';

const copy = (x) => structuredClone(x);
const PIXEL = [
  { id: 501, opportunita_stato: 'candidata', direttrice_id: 601,
    direttrice_stato: 'attiva', nodi: [5, 6], engine_id: 'pixel-engine-1', versione: 3 },
  { id: 502, opportunita_stato: 'candidata', direttrice_id: 602,
    direttrice_stato: 'attiva', nodi: [6, 5], engine_id: 'pixel-engine-2', versione: 4 }
];
const legs = (n) => Array.from({length:n-1}, (_, i) => ({metres:i%2 ? 869 : 0, seconds:i%2 ? 138 : 50}));
const base = Date.parse('2027-04-01T10:00:00Z');
function fixture(v2) {
  const nodes = v2 ? [14,14,15,15,15,15,14,14] : [5,6,6,5];
  const ranges = v2 ? [[0,3],[4,7]] : [[0,1],[2,3]];
  const ids = [900001,900002];
  const globalRequests = ranges.map(([s,e],i)=>({id:ids[i],start:s,end:v2?s+2:e}));
  const missioni = ranges.map(([s,e],i)=>({
    pixelOpportunitaId:501+i,
    corridoioPixelId:`pixel-engine-${i+1}`,
    ...(v2 ? {schemaVersion:2,tipoItinerario:'FERMATE_FISICHE',
      nodiTerritoriali:i===0?[5,6]:[6,5],pixelDirettriceId:601+i,pixelVersione:3+i} : {}),
    nodes:nodes.slice(s,e+1), legs:legs(nodes.length).slice(s,e),
    departure:new Date(base+i*600000).toISOString(),
    arrival:new Date(base+(i*600000)+300000).toISOString(),
    requests:[{id:ids[i],start:0,end:v2?2:1}]
  }));
  const pianoGlobale = {
    ...(v2 ? {schemaVersion:2,tipoItinerario:'FERMATE_FISICHE'} : {}),
    nodes,legs:legs(nodes.length),
    missioni:ranges.map(([startIndex,endIndex],i)=>({ordine:i+1,startIndex,endIndex})),
    evaluation:{requests:globalRequests}
  };
  return {missioni,pianoGlobale};
}
function clientMock() {
  const calls=[];
  let nextId=8000;
  return {
    calls,
    async query(sql,params=[]) {
      const q=sql.replace(/\s+/g,' ').trim().toLowerCase();
      calls.push({q,params:copy(params)});
      if (q.startsWith('select') && q.includes('from public.pixel_opportunita o')) {
        const row=PIXEL.find(x=>x.id===Number(params[0]));
        return {rows:row?[copy(row)]:[]};
      }
      if (q.startsWith('select') && q.includes('from public.pixel_opportunita_richieste')) {
        const id=Number(params[0]);
        return {rows:[{richiesta_id:id===501?900001:900002}]};
      }
      if (q.startsWith('insert into public.popbus_attivazione_missioni'))
        return {rows:[{id:++nextId}]};
      if (q.startsWith('insert into public.popbus_missione_richieste') ||
          q.startsWith('insert into public.popbus_attivazione_richieste'))
        return {rows:[]};
      throw new Error(`MOCK: SQL inatteso: ${q.slice(0,150)}`);
    }
  };
}
function inserts(client) {return client.calls.filter(c=>c.q.startsWith('insert'));}
let pass=0, fail=0;
async function testV1() {
  const db=clientMock();
  const input=fixture(false);
  try {
    const ids=await registraMissioniAttivazione(db,{attivazioneId:7001,...input});
    assert.equal(ids.length,2);
    const m=inserts(db).filter(c=>c.q.includes('popbus_attivazione_missioni'));
    assert.equal(m.length,2);
    assert.deepEqual(m[0].params[4],[5,6]);
    assert.deepEqual(m[1].params[4],[6,5]);
    assert.deepEqual(JSON.parse(m[0].params[7]).nodes,[5,6]);
    assert.equal(inserts(db).length,6);
    pass++;
    console.log('PASS V1 - 2 missioni territoriali, 2 mapping locali e 2 globali');
  } catch(e) {fail++;console.log('FAIL V1 -',e.stack||e);}
}
async function testV2() {
  const db=clientMock();
  const input=fixture(true);
  try {
    const ids=await registraMissioniAttivazione(db,{attivazioneId:7002,...input});
    assert.equal(ids.length,2);
    const m=inserts(db).filter(c=>c.q.includes('popbus_attivazione_missioni'));
    assert.equal(m.length,2);
    assert.deepEqual(m[0].params[4],[5,6], 'colonna territoriale PIXEL');
    assert.deepEqual(m[1].params[4],[6,5], 'colonna territoriale PIXEL');
    const p=JSON.parse(m[0].params[7]);
    assert.deepEqual(p.nodes,[14,14,15,15], 'JSON piano fisico');
    assert.equal(p.schemaVersion,2);
    assert.equal(p.tipoItinerario,'FERMATE_FISICHE');
    assert.deepEqual(p.pixel.nodiTerritoriali,[5,6]);
    assert.equal(p.pixel.direttriceId,601);
    assert.equal(p.pixel.versione,3);
    assert.equal(p.pixel.engineId,'pixel-engine-1');
    assert.equal(inserts(db).length,6);
    pass++;
    console.log('PASS V2 - contratto fisico/territoriale persistito correttamente');
  } catch(e) {
    if (String(e.message).startsWith('MOCK:')) {
      fail++;console.log('FAIL FIXTURE -',e.stack||e);
    } else {
      console.log('RED V2 -',e.message);
      console.log(`         INSERT simulati prima del rifiuto: ${inserts(db).length}`);
      if (inserts(db).length!==0) {
        fail++;console.log('FAIL SICUREZZA - scritture simulate prima del rifiuto V2');
      } else {
        fail++;console.log('RED ATTESO - persistenza V2 non ancora supportata');
      }
    }
  }
}
console.log('=== TURENTU - PERSISTENZA CICLO PIXEL V1/V2 MOCK RED ===');
await testV1();
await testV2();
console.log(`\nRISULTATO: ${pass} PASS, ${fail} RED/FAIL. PostgreSQL mock; DB reale 0 scritture; LIVE NO.`);
if(fail) process.exitCode=1;
