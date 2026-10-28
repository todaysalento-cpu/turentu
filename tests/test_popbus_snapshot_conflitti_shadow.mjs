// Test isolato della funzione batch: nessuna connessione DB, nessuna scrittura.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../services/popbus/v2/pixel-first-multimission-service.js',import.meta.url),'utf8');
const start=source.indexOf('export async function creaVerificatoreConflittiSnapshotShadow(');
const end=source.indexOf('\nasync function candidates(',start);
assert.ok(start>=0 && end>start);
const fn=source.slice(start,end).replace('export async function','async function');
const context={};
vm.runInNewContext(`const positive=x=>Number.isSafeInteger(Number(x))&&Number(x)>0;const fail=m=>{throw Error(m)};${fn};globalThis.make=creaVerificatoreConflittiSnapshotShadow;`,context);
let calls=0;
const client={query:async(sql,params)=>{calls++;assert.match(sql,/UNION ALL/);assert.deepEqual(Array.from(params[0]),[361,363]);return {rows:[
  {vehicle_id:361,busy_start:'2026-11-01T12:00:00Z',busy_end:'2026-11-01T13:00:00Z',source:'attivazioni'},
  {vehicle_id:361,busy_start:'2026-11-01T15:00:00Z',busy_end:null,source:'corse'},
  {vehicle_id:363,busy_start:'2026-11-01T12:00:00Z',busy_end:null,source:'attivazioni'}
]};}};
const snapshot=await context.make(client,[361,363,361]);
const check=(id,a,b)=>snapshot.hasConflicts({id},Date.parse(a),Date.parse(b));
assert.equal(await check(361,'2026-11-01T12:30Z','2026-11-01T13:30Z'),true);
assert.equal(await check(361,'2026-11-01T13:00Z','2026-11-01T14:00Z'),false);
assert.equal(await check(361,'2026-11-01T16:00Z','2026-11-01T17:00Z'),true);
assert.equal(await check(363,'2026-11-01T12:30Z','2026-11-01T13:30Z'),false);
assert.equal(calls,1);
assert.equal(snapshot.diagnostica().verificheInMemoria,4);
console.log('POPBUS_SNAPSHOT_CONFLITTI_SHADOW_OK',JSON.stringify(snapshot.diagnostica()));
