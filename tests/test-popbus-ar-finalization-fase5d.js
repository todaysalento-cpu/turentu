// TURENTU POPBUS V2 - FASE 5D: TEST SOLO MOCK
// Copiare come tests/test-popbus-ar-finalization-fase5d.js
import assert from 'node:assert/strict';
import {provaFinalizzazioneAR} from '../services/popbus/v2/popbus-ar-finalization-fase5d.js';

const ready = {stato:'pronta',attivazioni:[102,101],gruppi:[{id:'test'}],anomalie:[]};
async function scenario(label,{preflight=ready,failAt=null,failFinalize=false}={}) {
  const log=[];
  const client={async query(sql){log.push(sql);return {rows:[]};}};
  const convert=async(_client,id)=>{
    log.push(`CONVERT ${id}`);
    if(id===failAt) throw new Error('Conversione fallita');
    return {id:`corsa-${id}`};
  };
  const finalize=async()=>{
    log.push('FINALIZE');
    if(failFinalize) throw new Error('Finalizzazione fallita');
  };
  let rejected=false;
  try {
    await provaFinalizzazioneAR({client,rootId:101,preflight:async()=>preflight,convert,finalize});
  } catch { rejected=true; }
  const shouldFail=preflight.stato!=='pronta'||failAt!==null||failFinalize;
  assert.equal(rejected,shouldFail,label);
  assert.equal(log[0],'BEGIN');
  assert.equal(log.at(-1),shouldFail?'ROLLBACK':'COMMIT');
  assert.equal(log.includes('COMMIT'),!shouldFail);
  if(preflight.stato==='pronta') assert.ok(log.indexOf('CONVERT 101') < log.indexOf('CONVERT 102') || failAt===101);
  console.log(`OK: ${label} | ${log.join(' -> ')}`);
}
await scenario('Due conversioni e finalizzazione riuscite');
await scenario('Seconda conversione fallita',{failAt:102});
await scenario('Prima conversione fallita',{failAt:101});
await scenario('Finalizzazione gruppi fallita',{failFinalize:true});
await scenario('Preflight non pronto',{preflight:{...ready,stato:'in_attesa'}});
console.log('FASE 5D: 5/5 TEST MOCK SUPERATI. NESSUN DATABASE.');
