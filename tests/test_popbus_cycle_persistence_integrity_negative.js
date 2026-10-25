// TURENTU — POPBUS V1/V2 persistenza: integrita' negativa PostgreSQL mock.
// Salvare come tests/test_popbus_cycle_persistence_integrity_negative.js
// Solo mock in memoria: nessuna connessione PostgreSQL, nessun LIVE.
import assert from 'node:assert/strict';
import { registraMissioniAttivazione } from '../services/popbus/v2/popbus-cycle-persistence.js';

const clone = x => structuredClone(x);
const base = Date.parse('2027-04-01T10:00:00Z');
const pixelBase = [
  {id:501,opportunita_stato:'candidata',direttrice_id:601,direttrice_stato:'attiva',nodi:[5,6],engine_id:'pixel-engine-1',versione:3},
  {id:502,opportunita_stato:'candidata',direttrice_id:602,direttrice_stato:'attiva',nodi:[6,5],engine_id:'pixel-engine-2',versione:4}
];
function fixture(v2=true) {
  const nodes = v2 ? [14,14,15,15,15,15,14,14] : [5,6,6,5];
  const ranges = v2 ? [[0,3],[4,7]] : [[0,1],[2,3]];
  const legs = Array.from({length:nodes.length-1},(_,i)=>({metres:i%2?869:0,seconds:i%2?138:50}));
  const missioni = ranges.map(([s,e],i)=>({
    pixelOpportunitaId:501+i,corridoioPixelId:`pixel-engine-${i+1}`,
    ...(v2?{schemaVersion:2,tipoItinerario:'FERMATE_FISICHE',
      nodiTerritoriali:i===0?[5,6]:[6,5],pixelDirettriceId:601+i,pixelVersione:3+i}:{}),
    nodes:nodes.slice(s,e+1),legs:clone(legs.slice(s,e)),
    departure:new Date(base+i*600000).toISOString(),
    arrival:new Date(base+i*600000+300000).toISOString(),
    requests:[{id:900001+i,start:0,end:v2?2:1}]
  }));
  return {
    missioni,
    pianoGlobale:{
      ...(v2?{schemaVersion:2,tipoItinerario:'FERMATE_FISICHE'}:{}),
      nodes,legs,
      missioni:ranges.map(([startIndex,endIndex],i)=>({ordine:i+1,startIndex,endIndex})),
      evaluation:{requests:ranges.map(([s,e],i)=>({id:900001+i,start:s,end:v2?s+2:e}))}
    },
    pixel:clone(pixelBase),
    associazioni:{501:[900001],502:[900002]}
  };
}
function mockDB(f) {
  const calls=[];let nextId=8000;
  return {
    calls,
    async query(sql,params=[]) {
      const q=sql.replace(/\s+/g,' ').trim().toLowerCase();
      calls.push({q,params:clone(params)});
      if(q.startsWith('select')&&q.includes('from public.pixel_opportunita o')) {
        const op=f.pixel.find(x=>x.id===Number(params[0]));
        return {rows:op?[clone(op)]:[]};
      }
      if(q.startsWith('select')&&q.includes('from public.pixel_opportunita_richieste')) {
        return {rows:(f.associazioni[Number(params[0])]??[]).map(richiesta_id=>({richiesta_id}))};
      }
      if(q.startsWith('insert into public.popbus_attivazione_missioni'))
        return {rows:[{id:++nextId}]};
      if(q.startsWith('insert into public.popbus_missione_richieste')||
         q.startsWith('insert into public.popbus_attivazione_richieste'))
        return {rows:[]};
      throw Error('MOCK: SQL non previsto: '+q.slice(0,160));
    }
  };
}
const writes = db => db.calls.filter(x=>x.q.startsWith('insert'));
let pass=0,fail=0;
async function positive(name,v2) {
  const f=fixture(v2),db=mockDB(f);
  try {
    const ids=await registraMissioniAttivazione(db,{attivazioneId:7001,missioni:f.missioni,pianoGlobale:f.pianoGlobale});
    assert.equal(ids.length,2);
    assert.equal(writes(db).length,6);
    const ms=writes(db).filter(x=>x.q.includes('popbus_attivazione_missioni'));
    assert.deepEqual(ms[0].params[4],[5,6]);
    const payload=JSON.parse(ms[0].params[7]);
    assert.deepEqual(payload.nodes,v2?[14,14,15,15]:[5,6]);
    if(v2) {
      assert.deepEqual(payload.pixel.nodiTerritoriali,[5,6]);
      assert.equal(payload.pixel.versione,3);
      assert.equal(payload.pixel.engineId,'pixel-engine-1');
    }
    pass++;console.log('PASS POS - '+name);
  }catch(e){fail++;console.log('FAIL POS - '+name+': '+(e.stack||e));}
}
async function negative(name,mutate) {
  const f=fixture(true),db=mockDB(f);
  try {
    mutate(f);
    await registraMissioniAttivazione(db,{attivazioneId:7001,missioni:f.missioni,pianoGlobale:f.pianoGlobale});
    fail++;console.log('FAIL NEG - '+name+': alterazione ACCETTATA');
  }catch(e) {
    if(String(e.message).startsWith('MOCK:')) {
      fail++;console.log('FAIL MOCK - '+name+': '+e.message);
    } else if(writes(db).length) {
      fail++;console.log('FAIL ATOMICITA - '+name+': '+writes(db).length+' INSERT simulati prima del rifiuto ('+e.message+')');
    } else {
      pass++;console.log('PASS NEG - '+name+': '+e.message);
    }
  }
}
console.log('=== TURENTU - PERSISTENZA PIXEL V2 INTEGRITA NEGATIVA MOCK ===');
await positive('regressione V1',false);
await positive('contratto fisico/territoriale V2',true);
await negative('nodi territoriali alterati',f=>{f.missioni[0].nodiTerritoriali=[5,99];});
await negative('nodi territoriali assenti',f=>{delete f.missioni[0].nodiTerritoriali;});
await negative('nodi territoriali invalidi',f=>{f.missioni[0].nodiTerritoriali=[5,-1];});
await negative('versione PIXEL alterata',f=>{f.missioni[0].pixelVersione=99;});
await negative('versione PIXEL assente',f=>{delete f.missioni[0].pixelVersione;});
await negative('direttrice PIXEL alterata',f=>{f.missioni[0].pixelDirettriceId=999;});
await negative('direttrice PIXEL assente',f=>{delete f.missioni[0].pixelDirettriceId;});
await negative('engine ID alterato',f=>{f.missioni[0].corridoioPixelId='tampered';});
await negative('engine ID assente',f=>{delete f.missioni[0].corridoioPixelId;});
await negative('fermata fisica locale alterata',f=>{f.missioni[0].nodes[2]=99;});
await negative('tratta fisica locale alterata',f=>{f.missioni[0].legs[1].metres+=10;});
await negative('indice locale di salita alterato',f=>{f.missioni[0].requests[0].start=1;});
await negative('indice globale di discesa alterato',f=>{f.pianoGlobale.evaluation.requests[0].end=3;});
await negative('richiesta non associata a PIXEL',f=>{f.associazioni[501]=[];});
await negative('richiesta duplicata fra missioni',f=>{f.missioni[1].requests[0].id=900001;});
await negative('opportunita PIXEL duplicata',f=>{f.missioni[1].pixelOpportunitaId=501;f.missioni[1].nodiTerritoriali=[5,6];f.missioni[1].corridoioPixelId='pixel-engine-1';f.missioni[1].pixelDirettriceId=601;f.missioni[1].pixelVersione=3;f.associazioni[501]=[900001,900002];});
await negative('missioni temporalmente sovrapposte',f=>{f.missioni[1].departure=f.missioni[0].departure;});
await negative('direttrice legacy nella missione V2',f=>{f.missioni[0].direttriceId=88;});
await negative('opportunita PIXEL non candidata',f=>{f.pixel[0].opportunita_stato='chiusa';});
await negative('contratto V2 globale incompleto',f=>{delete f.pianoGlobale.schemaVersion;});
await negative('contratto V2 missione incompleto',f=>{delete f.missioni[0].schemaVersion;});
await negative('opportunita PIXEL assente',f=>{delete f.missioni[0].pixelOpportunitaId;});
console.log(`\nRISULTATO: ${pass} PASS, ${fail} FAIL. DB reale: 0 scritture; LIVE: NO.`);
if(fail) process.exitCode=1;
