// Turentu PIXEL acceptance preflight: test isolato, nessuna connessione DB.
// Salva in tests/test_pixel_acceptance_preflight_mock.js
// Esegui: node tests\test_pixel_acceptance_preflight_mock.js
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { verificaAccettazionePixel } from '../services/popbus/v2/popbus-pixel-acceptance-preflight.js';

const base = () => ({
  activation: { id: 41, pixel_opportunita_id: 21, direttrice_id: null },
  plan: { nodes: [101,102,103], evaluation: { requests: [{ id: 8, start: 0, end: 2 }] } },
  op: { id: 21, opportunita_stato: 'candidata', direttrice_id: 11, direttrice_stato: 'attiva', nodi: [101,102,103], versione: 2 },
  missions: [{ pixel_opportunita_id: 21, nodi_territoriali: [101,102,103], piano: { pixel: { opportunitaId: 21, direttriceId: 11, versione: 2 } } }],
  associations: [{ richiesta_id: 8, indice_salita: 0, indice_discesa: 2 }]
});
function clientOf(s) {
  const calls = [];
  return { calls, async query(sql, args) {
    calls.push({sql,args});
    if (/FROM public\.pixel_opportunita o/.test(sql)) return {rows:[s.op]};
    if (/FROM public\.popbus_attivazione_missioni/.test(sql)) return {rows:s.missions};
    if (/FROM public\.popbus_attivazione_richieste ar/.test(sql)) return {rows:s.associations};
    throw new Error('Query inattesa: ' + sql.slice(0,100));
  }};
}
let passes = 0;
async function check(label, mutate, errorPattern) {
  const s=base(); if(mutate) mutate(s);
  const client=clientOf(s);
  if(errorPattern) await assert.rejects(() => verificaAccettazionePixel(client,s.activation,s.plan),errorPattern);
  else {
    const result=await verificaAccettazionePixel(client,s.activation,s.plan);
    assert.equal(result.opportunitaId,21); assert.equal(result.richieste,1);
    assert.equal(client.calls.length,3);
  }
  assert(client.calls.every(x=>/^\s*SELECT\b/i.test(x.sql)),'Il preflight deve eseguire solo SELECT');
  console.log('PASS',label); passes++;
}
await check('opportunita valida',null,null);
await check('opportunita superata',s=>{s.op.opportunita_stato='superata'},/non attiva/);
await check('direttrice disattivata',s=>{s.op.direttrice_stato='disattiva'},/non attiva/);
await check('versione cambiata',s=>{s.op.versione=3},/versione/);
await check('nodi modificati',s=>{s.op.nodi=[101,104,103]},/nodi/);
await check('missione assente',s=>{s.missions=[]},/missione/);
await check('richiesta estranea',s=>{s.associations=[]},/associate/);
await check('indici discordanti',s=>{s.associations[0].indice_salita=1},/indici/);
await check('direttrice legacy proibita',s=>{s.activation.direttrice_id=9},/legacy/);
const source=readFileSync(new URL('../services/popbus/v2/acceptance.js',import.meta.url),'utf8');
assert(source.includes("from './popbus-pixel-acceptance-preflight.js'"),'acceptance.js non importa il preflight');
assert(/if\s*\(a\.pixel_opportunita_id\s*!=\s*null\)/.test(source),'acceptance.js non invoca il preflight su attivazione PIXEL');
console.log('PASS acceptance.js importa e invoca il preflight PIXEL'); passes++;
console.log(`RISULTATO: ${passes}/10 PASS - MOCK, NON PostgreSQL / NON end-to-end`);
