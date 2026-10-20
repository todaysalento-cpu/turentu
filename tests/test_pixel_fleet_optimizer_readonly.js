// TURENTU — test isolato fleet optimizer, nessun DB e nessuna scrittura.
// Eseguire dalla root: node tests\test_pixel_fleet_optimizer_readonly.js
import assert from 'node:assert/strict';
import { ottimizzaFlotta } from '../services/popbus/v2/fleet-optimizer.js';
const base = Date.parse('2026-11-01T10:00:00Z');
const c = (name, vehicle, requests, from, to, margin) => ({
  name, veicolo: vehicle, richieste: requests, partenza_base: base + from * 60000,
  ritorno_base: base + to * 60000, margine_ciclo_con_attesa_euro: margin
});
let pass = 0;
function test(name, fn) { fn(); pass++; console.log('PASS', name); }
test('nessuna richiesta duplicata fra cicli', () => {
  const out = ottimizzaFlotta([c('A',361,[196,197],0,60,12),c('B',363,[197,198],0,60,20)]);
  assert.deepEqual(out.selezionati.map(x=>x.name),['B']);
});
test('stesso veicolo: intervalli sovrapposti vietati', () => {
  const out = ottimizzaFlotta([c('A',361,[196],0,60,12),c('B',361,[197],59,120,20)]);
  assert.equal(out.cicliSelezionati,1);
});
test('stesso veicolo: intervalli adiacenti consentiti', () => {
  const out = ottimizzaFlotta([c('A',361,[196],0,60,12),c('B',361,[197],60,120,20)]);
  assert.equal(out.cicliSelezionati,2);
});
test('veicoli diversi simultanei consentiti anche con medesimo titolare', () => {
  const out = ottimizzaFlotta([c('A',361,[196],0,60,12),c('B',363,[197],0,60,20)]);
  assert.equal(out.cicliSelezionati,2);
});
test('ottimo globale supera scelta greedy per margine singolo', () => {
  const out = ottimizzaFlotta([c('A',361,[196,197],0,60,30),c('B',361,[196],0,60,19),c('C',363,[197],0,60,19)]);
  assert.deepEqual(new Set(out.selezionati.map(x=>x.name)),new Set(['B','C']));
  assert.equal(out.margineTotaleEuro,38);
});
test('margine nullo o negativo escluso', () => {
  const out = ottimizzaFlotta([c('A',361,[196],0,60,0),c('B',363,[197],0,60,-1)]);
  assert.equal(out.cicliSelezionati,0);
});
test('richiesta duplicata interna: errore fail-closed', () => {
  assert.throws(()=>ottimizzaFlotta([c('A',361,[196,196],0,60,10)]),/duplicate/i);
});
test('limite candidati non certifica ottimalita globale', () => {
  const out = ottimizzaFlotta([c('A',361,[196],0,60,20),c('B',363,[197],0,60,10)],{maxCandidati:1});
  assert.equal(out.ottimoDimostrato,false);
  assert.equal(out.candidatiTagliati,1);
});
test('limite nodi non certifica ottimalita globale', () => {
  const out = ottimizzaFlotta([c('A',361,[196],0,60,20),c('B',363,[197],0,60,10)],{maxNodi:1});
  assert.equal(out.ottimoDimostrato,false);
  assert.equal(out.limiteNodiRaggiunto,true);
});
console.log('PIXEL_FLEET_OPTIMIZER_READONLY_JSON:'+JSON.stringify({passed:true,test:pass,dbWrites:0,limite:'Non verifica turni, routing, pagamenti, soglie commerciali, fattibilita multimissione'}));
