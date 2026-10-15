// TURENTU POPBUS V2 - DIAGNOSTICA TEMPORALE (SOLO CPU)
// Salva come tests/test_popbus_v2_diagnostico_temporale.js
// Esegui: node tests\test_popbus_v2_diagnostico_temporale.js
// NON modifica model.js, planner.js, worker.js, DB, Stripe o offerte.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import {
  generaCandidate, valutaRichieste, TOLLERANZA_MS
} from '../services/popbus/v2/model.js';

const BASE_MS = Date.parse('2027-04-01T10:00:00.000Z');
const LEG_SECONDS = 600; // durata stradale sintetica CERTA solo per questo test
const LEG_METRES = 10000;
const LIMIT = 500;
const MIN = 60000;
const Ns = [10, 20, 30, 31, 32];
const scenarios = [
  { name: 'allineate', offset: () => 0 },
  { name: 'alternate_2h', offset: i => i % 2 ? 120 : 0 },
  { name: 'progressive_2h', offset: i => i * 120 },
];

function requests(n, scenario) {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    start_node_id: i + 1,
    end_node_id: i + 2,
    start_datetime: new Date(BASE_MS + i * LEG_SECONDS * 1000 +
      scenario.offset(i) * MIN).toISOString(),
    posti_richiesti: 1,
    prezzo: 30,
    classe: 'STANDARD',
    classe_percorrenza: 'BASSA'
  }));
}

function syntheticPlan(nodes, classe) {
  return {
    nodes,
    classe,
    legs: Array.from({ length: nodes.length - 1 }, () => ({
      metres: LEG_METRES, seconds: LEG_SECONDS, roadCoincident: false
    }))
  };
}

// Prefiltro TEORICO: calcola l'intersezione delle finestre di partenza
// usando tempi di percorrenza NOTI. Non va copiato nel generatore di
// produzione senza disporre di tempi stradali affidabili.
function temporalIntersection(candidate, byId) {
  let lower = -Infinity, upper = Infinity;
  for (const id of candidate.seeds) {
    const r = byId.get(id);
    const index = candidate.nodes.indexOf(Number(r.start_node_id));
    if (index < 0) return false;
    const t0 = Date.parse(r.start_datetime) - index * LEG_SECONDS * 1000;
    lower = Math.max(lower, t0 - TOLLERANZA_MS);
    upper = Math.min(upper, t0 + TOLLERANZA_MS);
    if (lower > upper) return false;
  }
  return true;
}

function evaluateCandidate(candidate, allRequests) {
  const plan = syntheticPlan(candidate.nodes, candidate.classe);
  return valutaRichieste(plan, allRequests, candidate.seeds, {
    mode: 'seeds_only', qualityEnabled: false
  });
}

const results = [];
let errors = 0;
console.log('=== POPBUS V2 | DIAGNOSTICA TEMPORALE | SOLO CPU ===');
console.log('Routing sintetico: ogni tratta = 10 km, 10 minuti.');
console.log('La qualita e disabilitata SOLO per isolare la compatibilita temporale.');
console.log('Nessun database, nessuna chiamata di rete, nessuna modifica.');

for (const scenario of scenarios) {
  for (const n of Ns) {
    const rs = requests(n, scenario);
    const byId = new Map(rs.map(r => [r.id, r]));
    const startGen = performance.now();
    let candidates;
    try {
      candidates = generaCandidate(rs, LIMIT);
    } catch (e) {
      const expectedLimit = /Limite 500 candidate/.test(String(e.message));
      results.push({
        scenario: scenario.name, richieste: n, candidate: '-',
        valide: '-', incompatibili: '-', eliminabili_pct: '-',
        falsi_negativi: '-', generazione_ms: +(performance.now() - startGen).toFixed(3),
        valutazione_ms: '-', esito: expectedLimit ? 'LIMITE_500' : 'ERRORE'
      });
      if (!expectedLimit) { errors++; console.error(e); }
      continue;
    }
    const generationMs = performance.now() - startGen;
    const startEval = performance.now();
    let valid = 0, invalid = 0, falseNegatives = 0, falsePositives = 0;
    for (const c of candidates) {
      const prefilter = temporalIntersection(c, byId);
      const actual = evaluateCandidate(c, rs) !== null;
      if (actual) valid++; else invalid++;
      if (!prefilter && actual) falseNegatives++;
      if (prefilter && !actual) falsePositives++;
    }
    const evaluationMs = performance.now() - startEval;
    if (falseNegatives || falsePositives) errors++;
    results.push({
      scenario: scenario.name, richieste: n, candidate: candidates.length,
      valide: valid, incompatibili: invalid,
      eliminabili_pct: +(100 * invalid / candidates.length).toFixed(1),
      falsi_negativi: falseNegatives,
      generazione_ms: +generationMs.toFixed(3),
      valutazione_ms: +evaluationMs.toFixed(3),
      esito: falseNegatives || falsePositives ? 'DIFF_PREFILTRO' : 'PASS'
    });
  }
}

// Caso critico: 35 minuti fra richieste, ma 35 minuti di percorrenza
// fra i nodi di salita. Non deve essere scartato per differenza oraria >30'.
{
  const a = {
    id: 9001, start_node_id: 1, end_node_id: 2,
    start_datetime: new Date(BASE_MS).toISOString(),
    posti_richiesti: 1, prezzo: 30, classe: 'STANDARD'
  };
  const b = {
    id: 9002, start_node_id: 2, end_node_id: 3,
    start_datetime: new Date(BASE_MS + 35 * MIN).toISOString(),
    posti_richiesti: 1, prezzo: 30, classe: 'STANDARD'
  };
  const p = {
    nodes: [1, 2, 3],
    legs: [
      { metres: 30000, seconds: 35 * 60, roadCoincident: false },
      { metres: 10000, seconds: 600, roadCoincident: false }
    ]
  };
  const compatible = valutaRichieste(p, [a, b], [9001, 9002], {
    mode: 'seeds_only', qualityEnabled: false
  }) !== null;
  console.log('\nCASO CRITICO: partenze distanti 35 min, trasferimento 35 min:', compatible ? 'PASS' : 'FAIL');
  if (!compatible) errors++;
}

console.table(results);
const checked = results.filter(r => r.esito === 'PASS');
const total = checked.reduce((s, r) => s + r.candidate, 0);
const invalid = checked.reduce((s, r) => s + r.incompatibili, 0);
console.log(`\nCandidate analizzate: ${total}; incompatibili temporalmente: ${invalid}.`);
console.log('ATTENZIONE: percentuali riferite a dataset sintetici, non al traffico reale.');
console.log('Il prefiltro qui conosce i tempi delle tratte; non e ancora implementabile');
console.log('in generaCandidate() senza una fonte affidabile di tempi di percorrenza.');
console.log(errors ? `ESITO: ${errors} anomalie` : 'ESITO: PASS diagnostico');
if (errors) process.exitCode = 1;
