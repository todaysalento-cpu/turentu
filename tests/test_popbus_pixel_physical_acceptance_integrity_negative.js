
// TURENTU - acceptance PIXEL multimissione V1/V2: test negativi con PostgreSQL mock.
// NON si connette a PostgreSQL, NON scrive dati, NON attiva LIVE.
// Esito atteso: 25 PASS, 0 FAIL, exit code 0.

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

// Il mock usa snapshot relazionali INDIPENDENTI dal payload mutabile.
// In questo modo alterare il piano non altera automaticamente anche le righe DB.
function makeState(physical = true) {
  const f = structuredClone(physical ? fixtureV2() : fixtureV1());
  f.missions = f.missions.map(m => ({ ...m, piano: structuredClone(m.piano) }));
  return {
    ...f,
    opportunities: structuredClone(opportunities),
    associations: { 501: [900001], 502: [900002] },
    localRows: f.missions.flatMap(m => m.piano.requests.map(r => ({
      missione_id: m.id, richiesta_id: r.id,
      indice_salita: r.start, indice_discesa: r.end
    }))),
    globalRows: f.plan.evaluation.requests.map(r => ({
      richiesta_id: r.id, indice_salita: r.start,
      indice_discesa: r.end, attiva: true
    }))
  };
}

function mockClient(f) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      const q = sql.replace(/\s+/g, ' ').trim().toLowerCase();
      calls.push(q);
      if (!q.startsWith('select')) throw Error('MOCK: query non SELECT vietata');
      if (q.includes('from public.popbus_attivazione_missioni') && !q.includes('join'))
        return { rows: structuredClone(f.missions) };
      if (q.includes('from public.pixel_opportunita o')) {
        const op = f.opportunities.find(o => o.id === Number(params[0]));
        return { rows: op ? [{
          id: op.id, opportunita_stato: op.stato,
          direttrice_id: op.direttrice_id,
          direttrice_stato: op.direttrice_stato,
          nodi: [...op.nodi], engine_id: op.engine_id,
          versione: op.versione
        }] : [] };
      }
      if (q.includes('from public.pixel_opportunita_richieste'))
        return { rows: (f.associations[Number(params[0])] ?? [])
          .map(richiesta_id => ({ richiesta_id })) };
      if (q.includes('from public.popbus_missione_richieste mr'))
        return { rows: structuredClone(f.localRows) };
      if (q.includes('from public.popbus_attivazione_richieste'))
        return { rows: structuredClone(f.globalRows) };
      throw Error(`MOCK: SELECT non riconosciuta: ${q.slice(0, 160)}`);
    }
  };
}

const activation = { id: 7001, direttrice_id: null };
let passed = 0;
let failed = 0;

async function positive(name, physical) {
  const f = makeState(physical);
  const client = mockClient(f);
  try {
    const result = await verificaAccettazionePixelMulti(client, activation, f.plan);
    assert.equal(result.missioni, 2);
    assert.equal(result.richieste, 2);
    assert.equal(client.calls.length, 7);
    passed++;
    console.log(`PASS - ${name} (${client.calls.length} SELECT)`);
  } catch (err) {
    failed++;
    console.log(`FAIL - ${name}: ${err.stack ?? err}`);
  }
}

async function negative(name, mutate, expectedFragment = '') {
  const f = makeState(true);
  const act = structuredClone(activation);
  mutate(f, act);
  const client = mockClient(f);
  try {
    await verificaAccettazionePixelMulti(client, act, f.plan);
    failed++;
    console.log(`FAIL - ${name}: manomissione ACCETTATA`);
  } catch (err) {
    if (String(err.message).startsWith('MOCK:')) throw err;
    if (!String(err.message).startsWith('PIXEL_MULTI_ACCEPTANCE:')) {
      failed++;
      console.log(`FAIL - ${name}: errore inatteso ${err.stack ?? err}`);
    } else if (expectedFragment && !String(err.message).includes(expectedFragment)) {
      failed++;
      console.log(`FAIL - ${name}: rifiuto inatteso ${err.message}`);
    } else {
      passed++;
      console.log(`PASS - ${name}: rifiutata (${err.message})`);
    }
  }
}

console.log('=== TURENTU - ACCEPTANCE V2 INTEGRITA NEGATIVA MOCK ===');
await positive('regressione V1', false);
await positive('contratto V2', true);
await negative('direttrice PIXEL modificata', f => { f.opportunities[0].nodi = [5, 9]; }, 'direttrice modificata');
await negative('versione PIXEL modificata', f => { f.opportunities[0].versione = 99; }, 'identita o versione');
await negative('engine_id PIXEL modificato', f => { f.opportunities[0].engine_id = 'tampered'; }, 'engine_id discordante');
await negative('snapshot engineId alterato', f => { f.missions[0].piano.pixel.engineId = 'tampered'; }, 'identita o versione');
await negative('snapshot nodi territoriali alterato', f => { f.missions[0].piano.pixel.nodiTerritoriali = [5, 99]; }, 'payload fisico/territoriale');
await negative('colonna nodi territoriali alterata', f => { f.missions[0].nodi_territoriali = [5, 99]; }, 'payload fisico/territoriale');
await negative('fermata fisica locale alterata', f => { f.missions[0].piano.nodes[2] = 99; }, 'payload fisico/territoriale');
await negative('tratta locale alterata', f => { f.missions[0].piano.legs[1].metres += 10; }, 'geometria discordante');
await negative('tempo sosta locale alterato', f => { f.missions[0].piano.legs[0].seconds += 10; }, 'geometria discordante');
await negative('richiesta rimossa da opportunita', f => { f.associations[501] = []; }, 'associazione o indici');
await negative('indice locale di salita alterato', f => { f.missions[0].piano.requests[0].start = 1; }, 'associazione o indici');
await negative('indice globale di discesa alterato', f => { f.plan.evaluation.requests[0].end = 3; }, 'associazione o indici');
await negative('indice locale DB alterato', f => { f.localRows[0].indice_salita = 1; }, 'associazioni locali DB discordanti');
await negative('indice globale DB alterato', f => { f.globalRows[0].indice_discesa = 3; }, 'associazioni globali DB discordanti');
await negative('opportunita duplicata', f => { f.missions[1].pixel_opportunita_id = 501; }, 'opportunita PIXEL ripetuta');
await negative('missione persistita mancante', f => { f.missions.pop(); }, 'numero missioni discordante');
await negative('missione in ordine errato', f => { f.missions[0].ordine = 2; }, 'ordine o direttrice legacy');
await negative('contratto V2 dichiarato incompleto', f => { delete f.plan.schemaVersion; }, 'contratto V2 incompleto');
await negative('contratto V2 dichiarato incompleto (tipo assente)', f => { delete f.plan.tipoItinerario; }, 'contratto V2 incompleto');
await negative('richiesta globale duplicata', f => { f.plan.evaluation.requests.push({ ...f.plan.evaluation.requests[0] }); }, 'mapping globale non valido');
await negative('richiesta locale duplicata tra missioni', f => { f.missions[1].piano.requests[0].id = 900001; }, 'associazione o indici');
await negative('opportunita non candidata', f => { f.opportunities[0].stato = 'chiusa'; }, 'opportunita o direttrice non attiva');
await negative('attivazione associata a legacy', (f, act) => { act.direttrice_id = 1; }, 'direttrice legacy');

console.log(`\nRISULTATO: ${passed} PASS, ${failed} FAIL. Mock PostgreSQL; DB writes: 0; LIVE: NO.`);
if (failed) process.exitCode = 1;
