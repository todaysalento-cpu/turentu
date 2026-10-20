// TURENTU — Test reale delle funzioni di formazione di model.js, senza DB o worker.
// Copiare in tests/ e rinominare .mjs; richiede model_aggiornato_ar.js.txt nella stessa cartella.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const modelSource = readFileSync(new URL('./model_aggiornato_ar.js.txt', import.meta.url), 'utf8');
// Isolamento del modulo puro: l'import di cycle-pricing non viene usato dalle funzioni testate.
// Se il sorgente cambia, fermarsi invece di simulare la valutazione economica.
const importLine = "import { valutaEconomiaCiclo } from './cycle-pricing.js';";
assert.equal(modelSource.split(importLine).length, 2, 'Import model.js inatteso: test non valido');
const source = modelSource.replace(importLine, 'const valutaEconomiaCiclo = () => { throw new Error("pricing non disponibile nel test"); };');
const { valutaRichieste, generaFormazioniAlternative } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const group='123e4567-e89b-42d3-a456-426614174000';
const plan={nodes:[1,2,3],legs:[{metres:10000,seconds:600},{metres:10000,seconds:600}]};
const when='2027-04-01T12:00:00.000Z';
const req=(id,start,end,prezzo,posti=1,ar=false,tratta=null)=>({id,start_node_id:start,end_node_id:end,start_datetime:when,posti_richiesti:posti,prezzo,ar_vincolata:ar,ar_group_id:ar?group:null,ar_tratta:tratta});
const ordinary=req(11,1,3,12);
const other=req(12,1,3,8);
const outbound=req(101,1,3,9,1,true,'andata');
const options={maxPeak:3,qualityEnabled:false};
let passed=0;
function test(name,fn){fn();passed++;console.log('PASS '+name);}
const ids=e=>e.requests.map(x=>x.id).sort((a,b)=>a-b);
const cents=v=>Math.round(v*100);
const economic=(evaluation, kmApproach,kmReturn,euroKm,commissionPct=15)=>{
  assert.ok(evaluation && Number.isFinite(evaluation.revenue));
  const gross=cents(evaluation.revenue);
  const totalKm=kmApproach+plan.legs.reduce((s,l)=>s+l.metres/1000,0)+kmReturn;
  const cost=cents(totalKm*euroKm);
  const commission=Math.round(gross*commissionPct/100);
  return {gross,cost,commission,margin:gross-cost-commission,totalKm};
};
const mixed=valutaRichieste(plan,[ordinary,other,outbound],[11],options);
const solo=valutaRichieste(plan,[ordinary,other,outbound],[11],{...options,excludeIds:[101]});
test('formazione mista comprende ordinari e A/R',()=>assert.deepEqual(ids(mixed),[11,12,101]));
test('ricavo misto effettivo',()=>assert.equal(cents(mixed.revenue),2900));
test('esclusione A/R ricostruisce richieste ordinarie',()=>assert.deepEqual(ids(solo),[11,12]));
test('ricavo ordinario ricalcolato dal model',()=>assert.equal(cents(solo.revenue),2000));
test('occupazione ricalcolata per tratta',()=>{assert.deepEqual(mixed.occupancy,[3,3]);assert.deepEqual(solo.occupancy,[2,2]);assert.equal(solo.peak,2);});
test('metadati A/R non migrano nella alternativa ordinaria',()=>assert.ok(solo.requests.every(r=>r.ar_vincolata===false)));
test('costo di ciclo include avvicinamento e ritorno',()=>{const e=economic(solo,5,5,0.4);assert.equal(e.totalKm,30);assert.equal(e.cost,1200);});
test('margine e commissione sono ricalcolati sul ricavo residuo',()=>{const e=economic(solo,5,5,0.4);assert.equal(e.commission,300);assert.equal(e.margin,500);});
test('la formazione mista non puo mantenere il suo margine dopo esclusione A/R',()=>assert.notEqual(economic(mixed,5,5,0.4).margin,economic(solo,5,5,0.4).margin));
test('generaFormazioniAlternative include una formazione solo ordinaria con seed ordinario',()=>{const alternatives=generaFormazioniAlternative(plan,[ordinary,other,outbound],[11],options);assert.ok(alternatives.some(e=>ids(e).join(',')==='11,12'));});
test('il seed A/R obbligatorio impedisce fallback ordinario automatico: gap rilevato',()=>{const alternatives=generaFormazioniAlternative(plan,[ordinary,other,outbound],[101],options);assert.ok(alternatives.length>0);assert.ok(alternatives.every(e=>ids(e).includes(101)));});
test('se la capienza cambia il model ricalcola una formazione fattibile',()=>{const e=valutaRichieste(plan,[ordinary,other,outbound],[11],{...options,maxPeak:1,excludeIds:[101]});assert.deepEqual(ids(e),[11]);assert.equal(e.peak,1);});
test('se tutte le richieste vengono escluse non si inventano ricavi',()=>assert.equal(valutaRichieste(plan,[outbound],[101],{...options,excludeIds:[101]}),null));
console.log('PIXEL_AR_ALTERNATIVE_ECONOMICHE_READONLY_JSON:'+JSON.stringify({passed:true,checksPassed:passed,checksTotal:13,dbWrites:0,workerModified:false,pricing:'formula di test indipendente, NON adapter economico di produzione',scope:'funzioni reali model.js con dati sintetici; dimostra fallback con seed ordinario e gap con seed A/R; NON certifica rigenerazione PIXEL, economia ciclo reale, attivazione o commit'}));
