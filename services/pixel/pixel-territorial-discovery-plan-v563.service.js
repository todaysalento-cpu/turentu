// services/pixel/pixel-territorial-discovery-plan-v563.service.js
// PIXEL V5.6.3: benchmark quote strategiche, senza Google e senza scritture.
// Riutilizza V5.6.1; NON introduce un secondo motore geografico.
import { pool } from '../../db/db.js';
import { planPixelTerritorialDiscoveryV561 } from './pixel-territorial-discovery-plan-v561.service.js';

const STRATEGIC = Object.freeze(['autobus', 'ferrovia', 'porto', 'aeroporto', 'stadio']);
const WEIGHTS = Object.freeze({ autobus: 3, ferrovia: 2, porto: 1, aeroporto: 1, stadio: 1 });
const round = x => Number(x.toFixed(3));

export function allocatePixelV563Quotas(centerCount, maxGoogleCalls = 48, strategicReserve = 4) {
  for (const [name, value] of Object.entries({ centerCount, maxGoogleCalls, strategicReserve })) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 500) throw new Error(`${name} non valido`);
  }
  // Una quota strategica non deve ridurre a zero la fase geografica se ci sono centri.
  const reserve = Math.min(strategicReserve, Math.max(0, maxGoogleCalls - (centerCount ? 1 : 0)));
  const quotas = Object.fromEntries(STRATEGIC.map(k => [k, 0]));
  let assigned = 0;
  while (assigned < reserve) {
    let progressed = false;
    for (const k of STRATEGIC) {
      if (assigned >= reserve) break;
      if (quotas[k] < WEIGHTS[k]) { quotas[k]++; assigned++; progressed = true; }
    }
    if (!progressed) break;
  }
  return { quotas, reserved: assigned, geographicBudget: maxGoogleCalls - assigned };
}

export async function comparePixelTerritorialDiscoveryV563(codiceIstat, {
  database = pool, maxGoogleCalls = 48, strategicReserves = [0, 2, 4, 8],
  ...territorialOptions
} = {}) {
  if (!/^\d{6}$/.test(String(codiceIstat))) throw new Error('Codice ISTAT non valido');
  if (!Number.isSafeInteger(maxGoogleCalls) || maxGoogleCalls < 0 || maxGoogleCalls > 500)
    throw new Error('maxGoogleCalls non valido');
  if (!Array.isArray(strategicReserves) || !strategicReserves.length || strategicReserves.length > 12 ||
      strategicReserves.some(x => !Number.isSafeInteger(x) || x < 0 || x > 500))
    throw new Error('strategicReserves non valido');
  const results = [];
  for (const reserve of [...new Set(strategicReserves)]) {
    // La prima esecuzione senza quote misura il massimo geografico per questo budget.
    // Ogni scenario e' indipendente: nessuna persistenza e nessuna chiamata HTTP.
    const started = performance.now();
    // Si conosce il numero di centri soltanto dopo una prima pianificazione;
    // la quota richiesta viene comunque limitata al budget e al numero di categorie.
    const preliminary = allocatePixelV563Quotas(1, maxGoogleCalls, reserve);
    const plan = await planPixelTerritorialDiscoveryV561(codiceIstat, {
      database, ...territorialOptions, maxGoogleCalls, categoryQuotas: preliminary.quotas,
    });
    const allocation = allocatePixelV563Quotas(plan.centri_disponibili, maxGoogleCalls, reserve);
    // La limitazione per 1 centro cambia solo nel caso maxGoogleCalls=0; in quel caso le quote sono zero.
    if (JSON.stringify(allocation.quotas) !== JSON.stringify(preliminary.quotas))
      throw new Error('Quote non coerenti: verificare il budget');
    const categories = plan.categorie;
    const strategicCalls = STRATEGIC.reduce((n, k) => n + (categories[k] ?? 0), 0);
    results.push({ riserva_richiesta: reserve, riserva_effettiva: allocation.reserved,
      centri_esplorati: plan.centri_esplorati,
      copertura_pct: plan.copertura_geometrica_piano_pct,
      chiamate: plan.chiamate_google_pianificate,
      chiamate_strategiche: strategicCalls,
      chiamate_non_usate: maxGoogleCalls - plan.chiamate_google_pianificate,
      categorie: categories, quote: allocation.quotas,
      durata_ms: Math.round(performance.now() - started),
      piano: plan.piano,
      verifiche: {
        budget: plan.chiamate_google_pianificate <= maxGoogleCalls,
        coppie_uniche: new Set(plan.piano.map(x => `${x.centro_id}:${x.categoria}`)).size === plan.piano.length,
        nessuna_google: plan.diagnostica.nessuna_chiamata_google === true,
        nessuna_scrittura: plan.diagnostica.nessuna_scrittura === true,
        confini: plan.centri_fuori_comune === 0,
      },
    });
  }
  const baseline = results.find(r => r.riserva_richiesta === 0);
  const scenarios = results.map(({ piano, ...r }) => ({
    ...r, differenza_vs_senza_quote_pp: baseline ? round(r.copertura_pct - baseline.copertura_pct) : null,
  }));
  return { comune: String(codiceIstat), modalita: 'DRY_RUN', max_google_calls: maxGoogleCalls,
    scenari: scenarios,
    avvertenza: 'Quote sperimentali non basate su infrastrutture reali. I tempi comprendono il ricalcolo V5.5.2 per scenario. Nessuna ottimizzazione SQL introdotta in questa versione.' };
}
