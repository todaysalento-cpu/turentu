// Test isolati del vero codice del pianificatore, senza connessioni DB o HTTP.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const sourcePath = new URL('../services/pixel/pixel-territorial-discovery-plan-v561.service.js', import.meta.url);
const original = await readFile(sourcePath, 'utf8');
const runnable = original
  .replace(/^import \{ pool \} from .*;\s*$/m, 'const pool = null;')
  .replace(/^import \{ generatePixelAdaptiveCenters \} from .*;\s*$/m,
    'const generatePixelAdaptiveCenters = globalThis.__pixelV561TestAdaptive;');
assert.doesNotMatch(runnable, /^import /m);
globalThis.__pixelV561TestAdaptive = async () => ({
  nome_comune: 'Bari', centri_base: 2, centri: [],
  copertura_finale_percentuale: 25, motivo_arresto: 'test'
});

const { planPixelTerritorialDiscoveryV561 } = await import(
  'data:text/javascript;base64,' + Buffer.from(runnable).toString('base64')
);


function mockDb(pct = 12.5) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({sql, params});
      if (sql.includes('ST_SquareGrid')) return {rows: [
        {lat:41.12,lon:16.87},{lat:41.10,lon:16.90}
      ]};
      if (sql.includes('NOT ST_Covers')) return {rows: []};
      if (sql.includes('AS pct')) return {rows: [{pct}]};
      if (sql.includes('AS gain_m2')) return {rows: [{id:'072006:base:1',gain_m2:500000}]};
      throw new Error('Query imprevista');
    }
  };
}

test('budget 4 interamente strategico: copertura calcolata sui centri del piano', async () => {
  const db = mockDb();
  const result = await planPixelTerritorialDiscoveryV561('072006', {
    database:db,maxGoogleCalls:4,categoryQuotas:{autobus:2,ferrovia:1,porto:1}
  });
  assert.equal(result.chiamate_google_pianificate,4);
  assert.equal(result.centri_esplorati_geografici,0);
  assert.equal(result.centri_pianificati_distinti,2);
  assert.equal(result.copertura_geometrica_piano_pct,12.5);
  const coverageCall = db.calls.find(x => x.sql.includes('AS pct'));
  assert.equal(JSON.parse(coverageCall.params[1]).length,2);
  assert.equal(db.calls.some(x => /\bINSERT\b|\bUPDATE\b|\bDELETE\b/i.test(x.sql)),false);
});

test('nessuna chiamata: nessun centro pianificato e copertura zero', async () => {
  const db = mockDb(0);
  const result = await planPixelTerritorialDiscoveryV561('072006', {
    database:db,maxGoogleCalls:0,categoryQuotas:{autobus:2,ferrovia:1,porto:1}
  });
  assert.equal(result.centri_pianificati_distinti,0);
  assert.equal(result.copertura_geometrica_piano_pct,0);
});

test('copertura SQL null con centri pianificati: errore esplicito', async () => {
  const db = mockDb(null);
  await assert.rejects(
    planPixelTerritorialDiscoveryV561('072006', {
      database:db,maxGoogleCalls:4,categoryQuotas:{autobus:2,ferrovia:1,porto:1}
    }), /Copertura geometrica non disponibile/
  );
});
