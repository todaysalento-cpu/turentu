/** TURENTU STEP 4.37.23 - Test read-only con client PostgreSQL simulato.
 * Posizionare in tests/ e lanciare: node tests/test_vehicle_commitments_STEP_4_37_23.mjs
 */
import assert from 'node:assert/strict';
import { caricaImpegniVeicolo, verificaSovrapposizioniVeicolo, verificaTrasferimentiVeicolo, bloccaVeicoloPerAssegnazione } from '../services/booking/vehicle-commitments.service.js';
const date = s => new Date(`2026-11-02T${s}:00Z`);
const item = (fonte,id,start,end,coords={origine_lat:40,origine_lon:18,destinazione_lat:40.1,destinazione_lon:18.1}) => ({fonte,riferimento_id:id,veicolo_id:5,stato:'confermata',inizio:date(start),fine:date(end),...coords});
function db(rows) { return {query: async (sql, args) => sql.includes('FROM veicolo WHERE id = $1 FOR UPDATE') ? {rows:[{id:args[0]}]} : {rows}}; }
const missione = {inizio:date('10:00'),fine:date('11:00'),origine:{lat:40.2,lon:18.2},destinazione:{lat:40.3,lon:18.3}};
let pass=0;
async function test(label,fn) {try {await fn();console.log('OK',label);pass++;}catch(e){console.error('FAIL',label,e);process.exitCode=1;}}
await test('caricamento impegni',async()=>assert.equal((await caricaImpegniVeicolo(db([item('NCC',1,'08:00','09:00')]),5)).length,1));
await test('sovrapposizione NCC bloccata',async()=>assert.equal((await verificaSovrapposizioniVeicolo(db([item('NCC',1,'10:30','11:30')]),5,missione.inizio,missione.fine)).disponibile,false));
await test('intervalli adiacenti ammessi',async()=>assert.equal((await verificaSovrapposizioniVeicolo(db([item('NCC',1,'09:00','10:00')]),5,missione.inizio,missione.fine)).disponibile,true));
await test('esclusione impegno corrente',async()=>assert.equal((await verificaSovrapposizioniVeicolo(db([item('NCC',1,'10:30','11:30')]),5,missione.inizio,missione.fine,{escludi:[{fonte:'NCC',id:1}]})).disponibile,true));
await test('trasferimento NCC fattibile',async()=>assert.equal((await verificaTrasferimentiVeicolo(db([item('NCC',1,'08:00','09:00')]),5,missione,{movement:async()=>({seconds:1200})})).compatibile,true));
await test('trasferimento NCC impossibile',async()=>{const r=await verificaTrasferimentiVeicolo(db([item('NCC',1,'08:00','09:45')]),5,missione,{movement:async()=>({seconds:1200})});assert.equal(r.compatibile,false);assert.equal(r.conflitti[0].motivo,'TRASFERIMENTO_IMPOSSIBILE');});
await test('routing sconosciuto fail closed',async()=>assert.equal((await verificaTrasferimentiVeicolo(db([item('NCC',1,'08:00','09:00')]),5,missione,{movement:async()=>{throw Object.assign(new Error('offline'),{code:'VEHICLE_TRANSFER_UNVERIFIED'})}})).compatibile,false));
await test('POPBUS precedente non concatenabile in questa fase',async()=>{const r=await verificaTrasferimentiVeicolo(db([item('POPBUS',2,'08:00','09:00',{})]),5,missione,{movement:async()=>({seconds:0})});assert.equal(r.compatibile,false);assert.equal(r.nonVerificabili[0].motivo,'POPBUS_ESTREMI_BUSY_NON_VERIFICATI');});
await test('POPBUS busy sovrapposto bloccato',async()=>assert.equal((await verificaSovrapposizioniVeicolo(db([item('POPBUS',2,'09:50','12:00',{})]),5,missione.inizio,missione.fine)).disponibile,false));
await test('intervallo non verificabile fail closed',async()=>assert.equal((await verificaSovrapposizioniVeicolo(db([{...item('NCC',1,'08:00','09:00'),fine:null}]),5,missione.inizio,missione.fine)).disponibile,false));
await test('lock veicolo',async()=>assert.equal(await bloccaVeicoloPerAssegnazione(db([]),5),5));
console.log(`\nTest superati: ${pass}/11`);
