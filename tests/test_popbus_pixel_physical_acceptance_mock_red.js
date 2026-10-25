// TURENTU - test comportamentale RED, acceptance PIXEL multimissione con mock PostgreSQL.
// Copiare in tests/test_popbus_pixel_physical_acceptance_mock_red.js
// Eseguire: node tests\test_popbus_pixel_physical_acceptance_mock_red.js
// NON si connette a PostgreSQL, NON scrive dati, NON attiva LIVE.
// Esito atteso PRIMA dell'adeguamento V2: V1 PASS, V2 RED, exit code 1.
import assert from 'node:assert/strict';
import { verificaAccettazionePixelMulti } from '../services/popbus/v2/popbus-pixel-multi-acceptance-preflight.js';

const opportunities = [
  { id: 501, stato: 'candidata', direttrice_id: 601, direttrice_stato: 'attiva', nodi: [5, 6], engine_id: 'pixel-engine-1', versione: 3 },
  { id: 502, stato: 'candidata', direttrice_id: 602, direttrice_stato: 'attiva', nodi: [6, 5], engine_id: 'pixel-engine-2', versione: 4 }
];

function leg(metres, seconds, polyline) { return { metres, seconds, polyline }; }
const r1 = { id: 900001, start: 0, end: 1 };
const r2 = { id: 900002, start: 0, end: 1 };

function fixtureV1() {
  const nodes = [5, 6, 6, 5];
  const legs = [leg(869, 138, 'road-a'), leg(0, 662, 'wait'), leg(882, 139, 'road-b')];
  const missions = [
    { id: 1001, ordine: 1, direttrice_id: null, pixel_opportunita_id: 501,
      corridoio_pixel_id: 'pixel-engine-1', nodi_territoriali: [5, 6],
      piano: { nodes: [5, 6], legs: [legs[0]], requests: [r1], pixel: { opportunitaId: 501, direttriceId: 601, versione: 3 } } },
    { id: 1002, ordine: 2, direttrice_id: null, pixel_opportunita_id: 502,
      corridoio_pixel_id: 'pixel-engine-2', nodi_territoriali: [6, 5],
      piano: { nodes: [6, 5], legs: [legs[2]], requests: [r2], pixel: { opportunitaId: 502, direttriceId: 602, versione: 4 } } }
  ];
  const plan = { nodes, legs, missioni: [
    { startIndex: 0, endIndex: 1 }, { startIndex: 2, endIndex: 3 }
  ], evaluation: { requests: [
    { id: 900001, start: 0, end: 1 }, { id: 900002, start: 2, end: 3 }
  ] } };
  return { plan, missions };
}

function fixtureV2() {
  const f = fixtureV1();
  // In V2 il piano globale e il JSON locale descrivono fermate fisiche.
  // La colonna nodi_territoriali conserva invece la sequenza PIXEL originale.
  const nodes = [14, 14, 15, 15, 15, 15, 14, 14];
  const legs = [
    leg(0, 50, 'stop-14'), leg(869, 138, 'road-14-15'), leg(0, 50, 'stop-15'),
    leg(0, 662, 'wait-15'),
    leg(0, 50, 'stop-15'), leg(882, 139, 'road-15-14'), leg(0, 50, 'stop-14')
  ];
  f.plan = {
    schemaVersion: 2, tipoItinerario: 'FERMATE_FISICHE', nodes, legs,
    missioni: [{ startIndex: 0, endIndex: 3 }, { startIndex: 4, endIndex: 7 }],
    evaluation: { requests: [{ id: 900001, start: 0, end: 2 }, { id: 900002, start: 4, end: 6 }] }
  };
  f.missions[0].piano = {
    schemaVersion: 2, tipoItinerario: 'FERMATE_FISICHE',
    nodes: nodes.slice(0, 4), legs: legs.slice(0, 3),
    requests: [{ id: 900001, start: 0, end: 2 }],
    pixel: { opportunitaId: 501, direttriceId: 601, versione: 3, engineId: 'pixel-engine-1', nodiTerritoriali: [5, 6] }
  };
  f.missions[1].piano = {
    schemaVersion: 2, tipoItinerario: 'FERMATE_FISICHE',
    nodes: nodes.slice(4, 8), legs: legs.slice(4, 7),
    requests: [{ id: 900002, start: 0, end: 2 }],
    pixel: { opportunitaId: 502, direttriceId: 602, versione: 4, engineId: 'pixel-engine-2', nodiTerritoriali: [6, 5] }
  };
  return f;
}

function mockClient(f) {
  const calls = [];
  const client = {
    calls,
    async query(sql, params = []) {
      const q = sql.replace(/\s+/g, ' ').trim().toLowerCase();
      calls.push({ sql: q, params });
      // Fail closed: query inattese non ricevono mai risposte di comodo.
      if (!q.startsWith('select')) throw Error('MOCK: query non SELECT vietata');
      if (q.includes('from public.popbus_attivazione_missioni') && !q.includes('join'))
        return { rows: structuredClone(f.missions) };
      if (q.includes('from public.pixel_opportunita o')) {
        const op = opportunities.find(o => o.id === Number(params[0]));
        return { rows: op ? [{ id: op.id, opportunita_stato: op.stato,
          direttrice_id: op.direttrice_id, direttrice_stato: op.direttrice_stato,
          nodi: [...op.nodi], engine_id: op.engine_id, versione: op.versione }] : [] };
      }
      if (q.includes('from public.pixel_opportunita_richieste')) {
        const id = Number(params[0]);
        return { rows: id === 501 ? [{ richiesta_id: 900001 }] : id === 502 ? [{ richiesta_id: 900002 }] : [] };
      }
      if (q.includes('from public.popbus_missione_richieste mr'))
        return { rows: f.missions.flatMap(m => m.piano.requests.map(r => ({
          missione_id: m.id, richiesta_id: r.id, indice_salita: r.start, indice_discesa: r.end
        }))) };
      if (q.includes('from public.popbus_attivazione_richieste'))
        return { rows: f.plan.evaluation.requests.map(r => ({
          richiesta_id: r.id, indice_salita: r.start, indice_discesa: r.end, attiva: true
        })) };
      throw Error(`MOCK: SELECT non riconosciuta: ${q.slice(0, 160)}`);
    }
  };
  return client;
}

async function run(name, f) {
  const client = mockClient(f);
  try {
    const result = await verificaAccettazionePixelMulti(client, { id: 7001, direttrice_id: null }, f.plan);
    assert.equal(result.missioni, 2);
    assert.equal(result.richieste, 2);
    assert.ok(client.calls.length >= 7);
    console.log(`PASS - ${name}: ${client.calls.length} SELECT simulate`);
    return true;
  } catch (e) {
    if (String(e.message).startsWith('MOCK:')) throw e;
    console.log(`RED - ${name}: ${e.message}`);
    return false;
  }
}

console.log('=== TURENTU - ACCEPTANCE PIXEL MOCK V1/V2 ===');
const v1 = await run('regressione V1', fixtureV1());
const v2 = await run('contratto fisico-territoriale V2', fixtureV2());
assert.equal(v1, true, 'Il comportamento V1 deve restare valido: controllare la fixture o una regressione');
if (!v2) {
  console.log('\nRISULTATO ATTESO PRE-IMPLEMENTAZIONE: V1 PASS, V2 RED.');
  console.log('Il test resta RED (exit code 1) finche il preflight produttivo non supporta V2.');
  process.exitCode = 1;
} else {
  console.log('\nRISULTATO: V1 PASS, V2 PASS - contratto mock supportato.');
  console.log('ATTENZIONE: mock, non equivale a collaudo DB/LIVE.');
}
