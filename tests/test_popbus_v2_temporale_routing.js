// POPBUS V2 - DIAGNOSTICA TEMPORALE CON ROUTING REALE
// SOLO LETTURA DB: nessuna connessione database, nessun worker, nessun pagamento.
// ATTENZIONE: planner.leg() / pianifica() effettuano richieste al servizio mappe.
// Eseguire dalla root: node tests\test_popbus_v2_temporale_routing.js
import { performance } from 'node:perf_hooks';
import { generaCandidate, valutaRichieste, TOLLERANZA_MS } from '../services/popbus/v2/model.js';
import { leg, pianifica } from '../services/popbus/v2/planner.js';

const MIN = 60000;
const BASE = Date.parse('2027-04-01T10:00:00Z');
const nodes = [
  { id: 910001, nome_nodo: 'Bari', lat: 41.1171, lon: 16.8719 },
  { id: 910002, nome_nodo: 'Brindisi', lat: 40.6327, lon: 17.9418 },
  { id: 910003, nome_nodo: 'Lecce', lat: 40.3515, lon: 18.1750 },
  { id: 910004, nome_nodo: 'Maglie', lat: 40.1195, lon: 18.2980 }
];
const byNode = new Map(nodes.map(n => [n.id, n]));
const scenarios = [
  { name: 'allineate', shifts: [0, 0, 0] },
  { name: 'alternate_2h', shifts: [0, 120, 0] },
  { name: 'progressive_2h', shifts: [0, 120, 240] }
];

function makeRequests(cumulative, shifts) {
  return Array.from({ length: 3 }, (_, i) => ({
    id: i + 1,
    start_node_id: nodes[i].id,
    end_node_id: nodes[i + 1].id,
    start_datetime: new Date(BASE + cumulative[i] * 1000 + shifts[i] * MIN).toISOString(),
    posti_richiesti: 1, prezzo: 100, classe: 'STANDARD'
  }));
}

function temporalWindow(candidate, requestsById, durationByEdge) {
  let lower = -Infinity, upper = Infinity, elapsed = 0;
  const at = new Map([[candidate.nodes[0], 0]]);
  for (let i = 1; i < candidate.nodes.length; i++) {
    const sec = durationByEdge.get(`${candidate.nodes[i - 1]}>${candidate.nodes[i]}`);
    if (!Number.isFinite(sec)) return null;
    elapsed += sec * 1000;
    at.set(candidate.nodes[i], elapsed);
  }
  for (const id of candidate.seeds) {
    const r = requestsById.get(id);
    if (!r || !at.has(Number(r.start_node_id))) return null;
    const origin = Date.parse(r.start_datetime) - at.get(Number(r.start_node_id));
    if (!Number.isFinite(origin)) return null;
    lower = Math.max(lower, origin - TOLLERANZA_MS);
    upper = Math.min(upper, origin + TOLLERANZA_MS);
  }
  return lower <= upper;
}

console.log('=== TURENTU POPBUS V2 | TEST ROUTING TEMPORALE REALE ===');
console.log('3 tratte: Bari > Brindisi > Lecce > Maglie');
console.log('Nessun DB / nessuna scrittura / nessun avvio worker.');
console.log('ATTENZIONE: usa il servizio routing configurato nel progetto.\n');

const durations = new Map();
let routeCalls = 0;
const start = performance.now();
try {
  for (let i = 0; i < nodes.length - 1; i++) {
    const a = nodes[i], b = nodes[i + 1];
    const t = performance.now();
    const result = await leg(a, b);
    routeCalls++;
    if (!Number.isFinite(result.seconds) || result.seconds <= 0) {
      throw new Error(`Durata non valida ${a.nome_nodo}>${b.nome_nodo}`);
    }
    durations.set(`${a.id}>${b.id}`, result.seconds);
    console.log(`TRATTA ${a.nome_nodo} > ${b.nome_nodo}: ${(result.seconds / 60).toFixed(1)} min, ${(result.metres / 1000).toFixed(1)} km, ${(performance.now() - t).toFixed(0)} ms`);
  }
} catch (e) {
  console.error('ROUTING NON DISPONIBILE:', e.message);
  console.error('Nessuna conclusione sulla compatibilita: verificare configurazione/quote del servizio mappe.');
  process.exitCode = 2;
}
if (process.exitCode !== 2) {
  const cumulative = [0];
  for (let i = 0; i < 3; i++) cumulative.push(cumulative.at(-1) + durations.get(`${nodes[i].id}>${nodes[i + 1].id}`));
  const results = [];
  let falseNegatives = 0, discrepancies = 0, plannerErrors = 0;
  for (const scenario of scenarios) {
    const requests = makeRequests(cumulative, scenario.shifts);
    const requestsById = new Map(requests.map(r => [r.id, r]));
    const candidates = generaCandidate(requests);
    for (const c of candidates) {
      const predicted = temporalWindow(c, requestsById, durations);
      let actual = null;
      let status = 'OK';
      let diffSeconds = null;
      try {
        const plan = await pianifica(c, nodes);
        // Valutazione dei soli seed, senza qualità: isoliamo la temporalità.
        actual = valutaRichieste(plan, requests, c.seeds, {
          mode: 'seeds_only', qualityEnabled: false
        }) !== null;
        // Confronto tempi cumulativi per gli stessi nodi obbligatori.
        const actualAt = new Map([[plan.nodes[0], 0]]);
        let elapsed = 0;
        for (let i = 1; i < plan.nodes.length; i++) {
          elapsed += plan.legs[i - 1].seconds;
          actualAt.set(plan.nodes[i], elapsed);
        }
        let estimated = 0, worst = 0;
        for (let i = 1; i < c.nodes.length; i++) {
          estimated += durations.get(`${c.nodes[i - 1]}>${c.nodes[i]}`);
          if (actualAt.has(c.nodes[i])) worst = Math.max(worst, Math.abs(estimated - actualAt.get(c.nodes[i])));
        }
        diffSeconds = +worst.toFixed(3);
        if (diffSeconds > 1) discrepancies++;
        if (predicted === false && actual === true) { falseNegatives++; status = 'FALSO_NEGATIVO'; }
        else if (predicted !== actual) status = 'DIFFERENZA';
      } catch (e) {
        plannerErrors++;
        status = 'PIANO_NON_VALIDO: ' + e.message;
      }
      results.push({
        scenario: scenario.name,
        seeds: c.seeds.join(','),
        nodi: c.nodes.length,
        prefiltro: predicted,
        piano_valido_temporalmente: actual,
        scarto_tempo_max_s: diffSeconds,
        esito: status
      });
    }
  }
  console.table(results);
  console.log('\nRIEPILOGO:', {
    candidate: results.length,
    pianiNonValidi: plannerErrors,
    falsiNegativi: falseNegatives,
    differenzeTempiOltre1s: discrepancies,
    chiamateEspliciteLeg: routeCalls,
    tempoTotaleMs: Math.round(performance.now() - start)
  });
  console.log('NOTA: chiamateEspliciteLeg non conta le chiamate interne a pianifica().');
  console.log('La cache interna del planner non espone contatori; non stimiamo risparmi API.');
  console.log('Questo test verifica solo 3 tratte reali e non dimostra assenza generale di falsi negativi.');
  console.log('Nessuna modifica ai file di produzione.');
  if (falseNegatives || results.some(r => r.esito === 'DIFFERENZA')) process.exitCode = 1;
}
