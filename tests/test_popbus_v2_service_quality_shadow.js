// TURENTU POPBUS V2 - TEST SERVICE QUALITY (READ ONLY, nessun DB)
// Salvare come tests/test_popbus_v2_service_quality_shadow.js
// Eseguire dalla root: node tests/test_popbus_v2_service_quality_shadow.js
import assert from 'node:assert/strict';
import { verificaQualitaOccorrenze, verificaQualita } from '../services/popbus/v2/service-quality.js';

const leg = (metres, seconds, roadCoincident = false) => ({ metres, seconds, roadCoincident });
const request = (id, start_node_id, end_node_id, overrides = {}) => ({
  id, start_node_id, end_node_id, ...overrides
});
const assignment = (richiesta, start, end) => ({ richiesta, start, end });
const cases = [
  {
    name: 'segmento normale valido',
    plan: { nodes: [1,2], legs: [leg(10000,900)] },
    assignments: [assignment(request(1,1,2),0,1)], expected: true
  },
  {
    name: 'coincidenza stradale certificata con tratta passeggero positiva',
    plan: { nodes: [1,2,3], legs: [leg(0,0,true),leg(10000,900)] },
    assignments: [assignment(request(2,1,3),0,2)], expected: true
  },
  {
    name: 'zero non certificato rifiutato',
    plan: { nodes: [1,2,3], legs: [leg(0,0),leg(10000,900)] },
    assignments: [assignment(request(3,1,3),0,2)], expected: false, reason:'SEGMENTO_NON_VALIDO'
  },
  {
    name: 'zero certificato ma intero percorso passeggero nullo',
    plan: { nodes: [1,2], legs: [leg(0,0,true)] },
    assignments: [assignment(request(4,1,2),0,1)], expected: false, reason:'TRATTA_PASSEGGERO_ZERO'
  },
  {
    name: 'nodo ripetuto con occorrenze distinte',
    plan: { nodes: [1,2,1,3], legs: [leg(3000,240),leg(3000,240),leg(10000,900)] },
    assignments: [assignment(request(5,1,3),2,3)], expected: true
  },
  {
    name: 'occorrenza non corrispondente alla richiesta',
    plan: { nodes: [1,2], legs: [leg(10000,900)] },
    assignments: [assignment(request(6,1,3),0,1)], expected: false, reason:'OCCORRENZA_NON_VALIDA'
  },
  {
    name: 'fermate commerciali troppo vicine',
    plan: { nodes: [1,2,3], legs: [leg(500,120),leg(9500,900)] },
    assignments: [assignment(request(7,1,3),0,2),assignment(request(8,2,3),1,2)],
    expected: false, reason:'FERMATE_TROPPO_VICINE'
  },
  {
    name: 'deviazione oltre limite',
    plan: { nodes: [1,2], legs: [leg(15000,1200)] },
    assignments: [assignment(request(9,1,2,{distanza_diretta_km:10}),0,1)],
    expected: false, reason:'DEVIAZIONE_ECCESSIVA'
  },
  {
    name: 'ritardo oltre limite',
    plan: { nodes: [1,2], legs: [leg(10000,3600)] },
    assignments: [assignment(request(10,1,2,{tempo_diretto_secondi:1200,max_ritardo_minuti:10}),0,1)],
    expected: false, reason:'RITARDO_ECCESSIVO'
  },
  {
    name: 'numero fermate oltre limite',
    plan: { nodes: [1,2,3], legs: [leg(5000,400),leg(5000,400)] },
    assignments: [assignment(request(11,1,3,{max_fermate_intermedie:0}),0,2),assignment(request(12,2,3),1,2)],
    expected: false, reason:'TROPPE_FERMATE'
  },
  {
    name: 'configurazione qualità non valida',
    plan: { nodes: [1,2], legs: [leg(10000,900)] },
    assignments: [assignment(request(13,1,2,{max_deviazione_pct:-1}),0,1)],
    expected: false, reason:'CONFIG_QUALITA_NON_VALIDA'
  }
];
let passed = 0;
console.log('=== POPBUS V2 SERVICE QUALITY SHADOW - SOLA LETTURA ===');
for (const c of cases) {
  try {
    const result = verificaQualitaOccorrenze(c.plan,c.assignments);
    assert.equal(result.ok,c.expected,`ok inatteso: ${JSON.stringify(result)}`);
    if(c.reason) assert.equal(result.motivo,c.reason);
    console.log('PASS',c.name,JSON.stringify(result));
    passed++;
  } catch(e) {
    console.error('FAIL',c.name,e.message);
    process.exitCode = 1;
  }
}
// Verifica parità tra API standard e API a occorrenze per un piano semplice.
try {
  const plan = { nodes:[1,2],legs:[leg(10000,900)] };
  const r = request(14,1,2);
  const standard = verificaQualita(plan,[r]);
  const occorrenze = verificaQualitaOccorrenze(plan,[assignment(r,0,1)]);
  assert.equal(standard.ok,occorrenze.ok);
  assert.equal(standard.ok,true);
  console.log('PASS parità API standard/occorrenze');
  passed++;
} catch(e) { console.error('FAIL parità API',e.message);process.exitCode=1; }
console.log(JSON.stringify({test:cases.length+1,superati:passed,falliti:cases.length+1-passed,read_only:true},null,2));
