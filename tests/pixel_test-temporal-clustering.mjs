import assert from 'node:assert/strict';
import { compatibilitaTemporalePreliminare, raggruppaRichiesteTemporali } from '../services/pixel/temporal-clustering.js';
import { intersezionePartenze } from '../services/pixel/model.js';
const at = (id, minutes, start = 10, end = 20) => ({ id, start_node_id: start, end_node_id: end, start_datetime: new Date(Date.parse('2027-04-01T09:00:00Z') + minutes * 60000).toISOString(), posti_richiesti: 1 });
let checks = 0;
function test(label, fn) { fn(); checks++; console.log(`PASS ${label}`); }
const a = at(1, 0), b = at(2, 35, 15, 30), c = at(3, 400), d = at(4, 5, 11, 40);
test('Orari 09:00 e 09:35 potenzialmente compatibili', () => assert.equal(compatibilitaTemporalePreliminare(a, b).compatibile, true));
test('Offset stradali coerenti: intersezione reale', () => assert.ok(intersezionePartenze([{richiesta:a,offsetSecondi:0},{richiesta:b,offsetSecondi:35*60}])));
test('Offset stradali incompatibili: rigetto finale', () => assert.equal(intersezionePartenze([{richiesta:a,offsetSecondi:0},{richiesta:b,offsetSecondi:3*3600}]), null));
test('Richiesta lontana nel tempo esclusa con orizzonte configurato', () => assert.equal(compatibilitaTemporalePreliminare(a,c,{maxTrasferimentoMinuti:180}).compatibile,false));
test('Le fasce raggruppano A B D e isolano C', () => {
 const r = raggruppaRichiesteTemporali([c,b,d,a]);
 assert.deepEqual(r.fasce.map(x=>x.richiestaIds),[[1,4,2],[3]]);
 assert.equal(r.richiesteTotali,4);
});
test('Determinismo rispetto all ordine input', () => assert.deepEqual(raggruppaRichiesteTemporali([a,b,c,d]),raggruppaRichiesteTemporali([d,c,b,a])));
test('Nessuna mutazione input', () => { const input = Object.freeze([Object.freeze({...a}),Object.freeze({...b})]); raggruppaRichiesteTemporali(input); assert.equal(input.length,2); });
test('ID duplicati respinti', () => assert.throws(()=>raggruppaRichiesteTemporali([a,a]),/duplicati/));
test('Limite computazionale esplicito', () => assert.throws(()=>raggruppaRichiesteTemporali([a,b,d],{maxCoppie:1}),/limite coppie/));
test('Input vuoto ammesso', () => assert.equal(raggruppaRichiesteTemporali([]).fasce.length,0));
test('Relazione non transitiva: non certifica formazione', () => {
 const x=at(11,0),y=at(12,200),z=at(13,400);
 const r=raggruppaRichiesteTemporali([x,y,z],{tolleranzaMinuti:0,maxTrasferimentoMinuti:210});
 assert.equal(r.fasce.length,1);
 assert.equal(compatibilitaTemporalePreliminare(x,z,{tolleranzaMinuti:0,maxTrasferimentoMinuti:210}).compatibile,false);
 assert.equal(r.verificataSuStrada,false);
});
console.log(`PIXEL TEMPORAL: ${checks} controlli superati; nessuna operazione DB/HTTP.`);
