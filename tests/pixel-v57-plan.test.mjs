import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizePixelV57Plan, runPixelV57PlanCycle } from '../services/pixel/pixel-territorial-plan-v57.mjs';

const fakePlan = comune => ({
  comune, modalita: 'DRY_RUN', centri_fuori_comune: 0,
  copertura_geometrica_piano_pct: 82.5,
  diagnostica: { nessuna_chiamata_google: true, nessuna_scrittura: true },
  piano: [
    { centro_id: 'a', categoria: 'trasporto', lat: 40.47, lon: 17.23 },
    { centro_id: 'a', categoria: 'autobus', lat: 40.47, lon: 17.23 },
    { centro_id: 'b', categoria: 'trasporto', lat: 40.48, lon: 17.24 },
  ],
});

test('aggregazione piano valida senza dati di fermate', () => {
  const r = summarizePixelV57Plan('073027', fakePlan('073027'), 4);
  assert.equal(r.chiamate_pianificate, 3);
  assert.equal(r.centri_esplorati, 2);
  assert.equal(r.scritture_fermate, 0);
  assert.equal(r.categorie.trasporto, 2);
});

test('rifiuta duplicati, budget superato e piano non dry-run', () => {
  const p = fakePlan('073027');
  assert.throws(() => summarizePixelV57Plan('073027', p, 2), /Budget/);
  assert.throws(() => summarizePixelV57Plan('073027', { ...p, modalita: 'ACTIVE' }, 4), /DRY_RUN/);
  assert.throws(() => summarizePixelV57Plan('073027', { ...p, piano: [...p.piano, p.piano[0]] }, 4), /duplicata/);
});

test('ciclo PLAN usa solo letture e planner iniettato', async () => {
  const queries = [];
  const db = { query: async (sql) => {
    queries.push(sql);
    if (!/^SELECT\b/i.test(sql)) throw new Error('Scrittura vietata');
    return { rows: [{ codice_istat_comune: '073027' }] };
  } };
  let calls = 0;
  const result = await runPixelV57PlanCycle({ mode: 'PLAN', auto: true, maxGoogleCalls: 4 }, {
    database: db,
    planner: async (comune, options) => {
      calls++;
      assert.equal(options.maxGoogleCalls, 4);
      return fakePlan(comune);
    },
    logger: { info() {}, error() {} },
  });
  assert.equal(queries.length, 1);
  assert.equal(calls, 1);
  assert.equal(result.eseguiti, 1);
  assert.equal(result.scritture_audit, 0);
});
