// Turentu POPBUS + PIXEL: test unitario senza database, Stripe o wallet.
// Eseguire dalla root backend: node tests/test_pixel_validation_readonly.mjs
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const servicePath = path.resolve(process.cwd(), 'services/pixel/pixel.validation.service.js');
const { validatePixelStops, isPopbusSlot } = await import(pathToFileURL(servicePath).href);
const base = { id: 'virtual_pop_pending_standard', tipo: 'pop-bus', origine_nodo_territoriale_id: 6, destinazione_nodo_territoriale_id: 8, origine_fermata_id: 101, destinazione_fermata_id: 102 };
const quote = { origine_nodo_territoriale_id: 6, destinazione_nodo_territoriale_id: 8, pixel_fermate_disponibili: true };
const stops = [
  {id:'101',nodo_territoriale_id:'6',attiva:true,verificata:true,tipi_veicolo_ammessi:['navetta','ncc']},
  {id:'102',nodo_territoriale_id:'8',attiva:true,verificata:true,tipi_veicolo_ammessi:['navetta']}
];
const nodes = [{id:'6',attivo:true},{id:'8',attivo:true}];
const mock = (s=stops,n=nodes) => ({ query: async sql => {
  if (sql.includes('FROM public.pixel_fermate')) return {rows:s};
  if (sql.includes('FROM public.nodi_territoriali')) return {rows:n};
  throw Error('Query inattesa: '+sql);
}});
let passed=0;
async function expectError(name, slot, quotation, status, client=mock()) {
  await assert.rejects(() => validatePixelStops(client,slot,quotation), e => e.status===status);
  console.log('PASS',name,'HTTP',status); passed++;
}
assert.equal(isPopbusSlot(base),true);
assert.equal(isPopbusSlot({id:'123',tipo:'condivisa'}),false);
console.log('PASS riconoscimento POPBUS/NCC'); passed++;
await expectError('fermate mancanti',{...base,origine_fermata_id:null,destinazione_fermata_id:null},quote,422);
await expectError('fermate identiche',{...base,destinazione_fermata_id:101},quote,422);
await expectError('preventivo PIXEL indisponibile',base,{...quote,pixel_fermate_disponibili:false},409);
await expectError('nodi preventivo incoerenti',base,{...quote,origine_nodo_territoriale_id:9},409);
await expectError('fermata disattivata',base,quote,422,mock([{...stops[0],attiva:false},stops[1]]));
await expectError('fermata non verificata',base,quote,422,mock([stops[0],{...stops[1],verificata:false}]));
await expectError('fermata su nodo sbagliato',base,quote,422,mock([stops[0],{...stops[1],nodo_territoriale_id:'7'}]));
await expectError('veicoli incompatibili',base,quote,422,mock([stops[0],{...stops[1],tipi_veicolo_ammessi:['autobus']}]));
await expectError('nodo territoriale inattivo',base,quote,422,mock(stops,[nodes[0],{...nodes[1],attivo:false}]));
const result = await validatePixelStops(mock(),base,quote);
assert.equal(result.origine_fermata_id,'101'); assert.equal(result.destinazione_fermata_id,'102');
console.log('PASS coppia PIXEL valida (dati simulati)'); passed++;
assert.equal(await validatePixelStops(mock(),{id:'123',tipo:'condivisa'},null),null);
console.log('PASS NCC tradizionale non richiede PIXEL'); passed++;
console.log(`\n${passed} test superati. Nessuna connessione DB o chiamata Stripe/wallet.`);
