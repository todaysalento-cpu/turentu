// PIXEL V5.6.1 - confronto di tre politiche, solo lettura PostGIS.
// Installare come tests/pixel-v561-budget-benchmark.mjs.
// Eseguire: node tests\pixel-v561-budget-benchmark.mjs 072006 4
import { pool } from '../db/db.js';
import { planPixelTerritorialDiscoveryV561 } from '../services/pixel/pixel-territorial-discovery-plan-v561.service.js';

const comune = process.argv[2] ?? '072006';
const budget = Number(process.argv[3] ?? 4);
if (!/^\d{6}$/.test(comune)) throw new Error('Codice ISTAT non valido');
if (!Number.isSafeInteger(budget) || budget !== 4) {
  throw new Error('Benchmark predisposto per budget 4; eseguire con argomento 4');
}

const scenari = [
  { nome: 'Attuale (4 strategiche)', quote: { autobus: 2, ferrovia: 1, porto: 1 } },
  { nome: 'Bilanciata (2 strategiche)', quote: { autobus: 1, ferrovia: 1 } },
  { nome: 'Prevalenza geografica (1 strategica)', quote: { autobus: 1 } },
];

const client = await pool.connect();
try {
  // Una singola fotografia dei dati, nessuna scrittura consentita dalla transazione.
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const risultati = [];
  for (const scenario of scenari) {
    const plan = await planPixelTerritorialDiscoveryV561(comune, {
      database: client,
      maxGoogleCalls: budget,
      categoryQuotas: scenario.quote,
    });
    if (plan.modalita !== 'DRY_RUN' || plan.diagnostica?.nessuna_chiamata_google !== true ||
        plan.diagnostica?.nessuna_scrittura !== true || plan.centri_fuori_comune !== 0 ||
        plan.piano.length > budget) {
      throw new Error(`Piano non conforme allo scenario: ${scenario.nome}`);
    }
    const categorie = Object.fromEntries(
      Object.entries(plan.categorie).filter(([, n]) => n > 0)
    );
    risultati.push({
      politica: scenario.nome,
      chiamate: plan.piano.length,
      strategiche: plan.piano.filter(x => x.categoria !== 'trasporto').length,
      geografiche: plan.piano.filter(x => x.categoria === 'trasporto').length,
      centri_distinti: new Set(plan.piano.map(x => x.centro_id)).size,
      copertura_pct: plan.copertura_geometrica_piano_pct,
      categorie: JSON.stringify(categorie),
    });
  }
  console.log(`\nPIXEL - benchmark DRY_RUN | comune ${comune} | budget ${budget}`);
  console.table(risultati);
  console.log('Nessuna chiamata Google, nessuna fermata censita o attivata.');
} catch (error) {
  console.error('[PIXEL BENCHMARK] errore:', error);
  process.exitCode = 1;
} finally {
  try { await client.query('ROLLBACK'); } finally {
    client.release();
    await pool.end();
  }
}
