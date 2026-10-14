// TEST DIAGNOSTICO POPBUS V2 — SOLA LETTURA, SENZA DB/ROUTING
// Posizionare in tests/test_popbus_v2_qualita_ritorni.js
// Eseguire: node tests/test_popbus_v2_qualita_ritorni.js
import assert from 'node:assert/strict';
import {
  generaCandidate, valutaRichieste, verificaQualitaRichieste,
  generaFormazioniAlternative, scegliAttivazioni
} from '../services/popbus/v2/model.js';
import { verificaQualitaOccorrenze } from '../services/popbus/v2/service-quality.js';
import {
  trovaOccorrenzeCompatibili, generaRitorniCompatibili, valutaSogliaCiclo
} from '../services/popbus/v2/return-matching.js';

const t0 = Date.parse('2027-04-01T08:00:00Z');
const date = minutes => new Date(t0 + minutes * 60000).toISOString();
const req = (id, start_node_id, end_node_id, minutes, prezzo = 20, extra = {}) => ({
  id, start_node_id, end_node_id, start_datetime: date(minutes),
  prezzo, posti_richiesti: 1, classe: 'STANDARD',
  // Isola i test dal tuning futuro delle soglie di qualità.
  max_fermate_intermedie: 20, min_km_tra_fermate: 0,
  max_deviazione_pct: 100, ...extra
});
const plan = (nodes, km = 20, minutes = 20) => ({
  nodes, legs: nodes.slice(1).map(() => ({
    metres: km * 1000, seconds: minutes * 60
  }))
});
const tests = [];
function test(name, fn) { tests.push({name, fn}); }
function has(ids, id) { return ids.some(x => Number(x) === id); }

// 1. Le richieste restano indipendenti e concatenabili.
test('candidate singole e concatenazione', () => {
  const rs = [req(1,1,2,0), req(2,2,3,20)];
  const cs = generaCandidate(rs);
  assert(cs.some(c => c.seeds.length === 1 && c.seeds[0] === 1));
  assert(cs.some(c => c.seeds.length === 1 && c.seeds[0] === 2));
  assert(cs.some(c => c.seeds.includes(1) && c.seeds.includes(2)));
});

// 2. La qualità conta solo le fermate durante il viaggio.
test('fermate individuali: prima della salita e dopo la discesa escluse', () => {
  const p = plan([1,2,3,4,5]);
  const r = req(3,2,4,20,{},{});
  r.prezzo = 10;
  r.max_fermate_intermedie = 1;
  const q = verificaQualitaOccorrenze(p,[{richiesta:r,start:1,end:3}],
    {stops:[0,2,4]});
  assert.equal(q.ok,true,JSON.stringify(q));
});

// 3. Fermate aggiunte da altri passeggeri possono invalidare il lungo.
test('troppi stop mentre un passeggero è a bordo', () => {
  const p = plan([1,2,3,4]);
  const lungo = req(4,1,4,0,50,{max_fermate_intermedie:1});
  const breve = req(5,2,3,20,10);
  const q = verificaQualitaOccorrenze(p,[
    {richiesta:lungo,start:0,end:3},
    {richiesta:breve,start:1,end:2}
  ]);
  assert.equal(q.ok,false);
  assert.equal(q.motivo,'TROPPE_FERMATE');
});

// 4. Nodi attraversati non equivalgono a fermate.
test('nodi di transito non conteggiati come fermate', () => {
  const p = plan([1,2,3,4,5]);
  const r = req(6,1,5,0,30,{max_fermate_intermedie:0});
  assert.equal(verificaQualitaOccorrenze(p,[{richiesta:r,start:0,end:4}]).ok,true);
});

// 5. Capienza per singolo segmento e mai duplicazione.
test('posti per segmento, non per intera missione', () => {
  const p = plan([1,2,3]);
  const a = req(7,1,2,0,10,{posti_richiesti:2});
  const b = req(8,2,3,20,10,{posti_richiesti:2});
  const f = generaRitorniCompatibili(p,[a,b],t0,{maxPosti:2});
  assert(f.some(x => has(x.requestIds,7) && has(x.requestIds,8)),JSON.stringify(f));
});

// 6. Sovraccarico simultaneo proibito.
test('vietato sovraccarico sullo stesso segmento', () => {
  const p = plan([1,2,3]);
  const a = req(9,1,3,0,10,{posti_richiesti:2});
  const b = req(10,1,2,0,10,{posti_richiesti:1});
  const f = generaRitorniCompatibili(p,[a,b],t0,{maxPosti:2});
  assert(!f.some(x => has(x.requestIds,9) && has(x.requestIds,10)));
});

// 7. Occorrenze distinte in un ciclo che ripassa dal nodo.
test('ritorno: stessa città, occorrenza cronologica corretta', () => {
  const p = plan([1,2,3,2,1],20,20);
  const r = req(11,2,1,60,30);
  const found = trovaOccorrenzeCompatibili(p,r,t0);
  assert(found.some(x => x.start===3 && x.end===4));
  assert(!found.some(x => x.start===1));
});

// 8. Finestra temporale stretta.
test('richiesta fuori tolleranza non aggregata', () => {
  const p = plan([1,2,3]);
  const r = req(12,2,3,90);
  assert.equal(trovaOccorrenzeCompatibili(p,r,t0).length,0);
});

// 9. Ricavo ritorno entra nella soglia solo se compatibile.
test('ritorno compatibile può raggiungere la soglia', () => {
  const p = plan([1,2,1],20,20);
  const outbound = req(13,1,2,0,30);
  const inbound = req(14,2,1,20,35);
  const formations = generaRitorniCompatibili(p,[inbound],t0,{
    maxPosti:4, baseAssignments:[{richiesta:outbound,start:0,end:1}]
  });
  const combined = formations.find(x => has(x.requestIds,13)&&has(x.requestIds,14));
  assert(combined,'Ritorno non trovato');
  assert.equal(valutaSogliaCiclo(combined,{costEuro:100,thresholdRatio:0.6}).attivabile,true);
  const alone = formations.find(x => has(x.requestIds,13)&&!has(x.requestIds,14));
  assert(alone,'Manca alternativa senza ritorno');
  assert.equal(valutaSogliaCiclo(alone,{costEuro:100,thresholdRatio:0.6}).attivabile,false);
});

// 10. Ritorno temporalmente incompatibile non deve contribuire.
test('ritorno incompatibile escluso dal ricavo', () => {
  const p = plan([1,2,1]);
  const outbound = req(15,1,2,0,30);
  const inbound = req(16,2,1,150,90);
  const formations = generaRitorniCompatibili(p,[inbound],t0,{
    maxPosti:4, baseAssignments:[{richiesta:outbound,start:0,end:1}]
  });
  assert(formations.length>0);
  assert(formations.every(x=>!has(x.requestIds,16)));
});

// 11. Nessuna mutazione della richiesta, nessuna classificazione permanente.
test('matching non modifica gli oggetti delle richieste', () => {
  const p = plan([1,2,1]);
  const r = Object.freeze(req(17,2,1,20,10));
  generaRitorniCompatibili(p,[r],t0,{maxPosti:4});
  assert.equal(Object.hasOwn(r,'tipo_richiesta'),false);
});

// 12. Selezione non duplica una richiesta su missioni diverse.
test('selezione: stessa richiesta assegnata una volta', () => {
  const evaluation = {requests:[{id:100}],revenue:100,peak:1};
  const a = {evaluation,cost:50,vehicle:{id:1,posti_totali:4},
    plan:{nodes:[1,2]},busyStart:t0,busyEnd:t0+3600000};
  const b = {...a,vehicle:{id:2,posti_totali:4}};
  assert.equal(scegliAttivazioni([a,b]).length,1);
});

// 13. Compatibilità temporale e qualità nel modello base.
test('valutazione base conserva controllo temporale', () => {
  const p=plan([1,2,3]);
  const a=req(18,1,2,0);
  const b=req(19,2,3,180);
  assert.equal(valutaRichieste(p,[a,b],[18,19]),null);
});

// 14. Deviazione individuale.
test('deviazione individuale oltre limite respinta', () => {
  const p=plan([1,2],30);
  const r=req(20,1,2,0,10,{
    distanza_diretta_km:20,max_deviazione_pct:10
  });
  const q=verificaQualitaOccorrenze(p,[{richiesta:r,start:0,end:1}]);
  assert.equal(q.ok,false);
  assert.equal(q.motivo,'DEVIAZIONE_ECCESSIVA');
});

// 15. Formazioni alternative sempre con seed obbligatorio.
test('formazioni alternative mantengono i seed', () => {
  const p=plan([1,2,3]);
  const a=req(21,1,3,0);
  const b=req(22,2,3,20);
  const formations=generaFormazioniAlternative(p,[a,b],[21]);
  assert(formations.length>0);
  assert(formations.every(x=>has(x.requests.map(r=>r.id),21)));
});

let passed=0, failed=0;
console.log('\nTURENTU POPBUS V2 — TEST QUALITÀ E RITORNI');
console.log('MODALITÀ SOLA LETTURA · NESSUN DATABASE · NESSUNA ATTIVAZIONE\n');
for(const {name,fn} of tests){
  try { await fn(); passed++; console.log(`✅ ${name}`); }
  catch(e) { failed++; console.error(`❌ ${name}\n   ${e.message}`); }
}
console.log(`\nRISULTATO: ${passed}/${tests.length} superati; ${failed} falliti`);
if(failed) process.exitCode=1;
