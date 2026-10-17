// Salvare come tests/test_popbus_persistenza_globale_P0B.mjs
// Eseguire da project-root. Mock SQL: ZERO connessioni DB / Stripe.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const file=resolve('services/popbus/v2/popbus-cycle-persistence.js');
const src=readFileSync(file,'utf8');
const { registraMissioniAttivazione }=await import(pathToFileURL(file).href);
let pass=0,fail=0;
async function test(name,fn){try{await fn();console.log('PASS',name);pass++;}catch(e){console.error('FAIL',name,e.message);fail++;}}
const base=Date.parse('2026-10-20T08:00:00Z');
const missioni=[0,1,2].map((i)=>({nodes:[11+i,12+i],legs:[{metres:1000,seconds:600,polyline:'abc'}],departure:base+i*1200000,arrival:base+i*1200000+600000,requests:[{id:101+i,start:0,end:1}]}));
const piano={nodes:[11,12,12,12,13,13,13,14],legs:Array.from({length:7},()=>({metres:0,seconds:0,polyline:'abc'})),missioni:[{ordine:1,startIndex:0,endIndex:1},{ordine:2,startIndex:3,endIndex:4},{ordine:3,startIndex:6,endIndex:7}],evaluation:{requests:[{id:101,start:0,end:1},{id:102,start:3,end:4},{id:103,start:6,end:7}]}};
function mock(){const calls=[];let id=0;return {calls,async query(sql,args){calls.push({sql,args});return {rows:sql.includes('RETURNING id')?[{id:++id}]:[]};}};}
console.log('=== TURENTU POPBUS P0-B / PERSISTENZA GLOBALE (SQL MOCK) ===');
await test('Interfaccia mantiene parametro opzionale',()=>assert.match(src,/pianoGlobale = null/));
await test('Mapping globale 3 missioni',async()=>{const db=mock();const ids=await registraMissioniAttivazione(db,{attivazioneId:50,missioni,pianoGlobale:piano});assert.equal(ids.length,3);const g=db.calls.filter(x=>x.sql.includes('INSERT INTO public.popbus_attivazione_richieste'));assert.deepEqual(g.map(x=>x.args.slice(1)),[[101,0,1],[102,3,4],[103,6,7]]);});
await test('Persistenza indici locali invariata',async()=>{const db=mock();await registraMissioniAttivazione(db,{attivazioneId:50,missioni,pianoGlobale:piano});const l=db.calls.filter(x=>x.sql.includes('INSERT INTO public.popbus_missione_richieste'));assert.deepEqual(l.map(x=>x.args.slice(1)),[[101,0,1],[102,0,1],[103,0,1]]);});
await test('Legacy senza mapping non inserisce globali',async()=>{const db=mock();await registraMissioniAttivazione(db,{attivazioneId:50,missioni:missioni.slice(0,1)});assert.equal(db.calls.filter(x=>x.sql.includes('INSERT INTO public.popbus_attivazione_richieste')).length,0);});
await test('Mapping errato respinto senza INSERT',async()=>{const db=mock();const bad=structuredClone(piano);bad.evaluation.requests[1].start=2;await assert.rejects(()=>registraMissioniAttivazione(db,{attivazioneId:50,missioni,pianoGlobale:bad}),/discordante/);assert.equal(db.calls.length,0);});
await test('Nodo globale errato respinto senza INSERT',async()=>{const db=mock();const bad=structuredClone(piano);bad.nodes[4]=999;await assert.rejects(()=>registraMissioniAttivazione(db,{attivazioneId:50,missioni,pianoGlobale:bad}),/discordanti/);assert.equal(db.calls.length,0);});
await test('Richiesta globale mancante respinta senza INSERT',async()=>{const db=mock();const bad=structuredClone(piano);bad.evaluation.requests.pop();await assert.rejects(()=>registraMissioniAttivazione(db,{attivazioneId:50,missioni,pianoGlobale:bad}),/discordante/);assert.equal(db.calls.length,0);});
await test('Il modulo non apre transazioni autonomamente',()=>assert.doesNotMatch(src,/client\.query\(['"`]BEGIN/));
await test('Il modulo non interagisce con Stripe',()=>assert.doesNotMatch(src,/paymentIntents|new Stripe/));
console.log(`ESITO: ${pass} PASS, ${fail} FAIL. SQL MOCK, zero DB/Stripe. Rollback reale NON verificato.`);
if(fail)process.exitCode=1;
