// services/pixel/pixel-territorial-discovery-plan-v562.service.js
// PIXEL V5.6.2: confronto controllato e quote adattive sperimentali.
// Solo SELECT PostGIS, nessuna API Google, nessuna scrittura.
import { pool } from '../../db/db.js';
import { planPixelTerritorialDiscovery } from './pixel-territorial-discovery-plan.service.js';
import { planPixelTerritorialDiscoveryV561 } from './pixel-territorial-discovery-plan-v561.service.js';

const STRATEGIC = ['autobus', 'ferrovia', 'porto', 'aeroporto', 'stadio'];
const DEFAULT_WEIGHTS = Object.freeze({ autobus: 3, ferrovia: 2, porto: 1, aeroporto: 1, stadio: 1 });
const round = n => Number(n.toFixed(3));

// Le quote sono un'ipotesi di test, NON una stima delle infrastrutture esistenti.
// Al crescere del numero di centri, si preserva una maggiore quota geografica.
export function allocatePixelV562Quotas(centerCount, maxCalls = 48, weights = DEFAULT_WEIGHTS) {
  if (!Number.isSafeInteger(centerCount) || centerCount < 0) throw new Error('centerCount non valido');
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 0 || maxCalls > 500) throw new Error('maxCalls non valido');
  if (!weights || typeof weights !== 'object' || Array.isArray(weights) ||
      Object.keys(weights).some(k => !STRATEGIC.includes(k)) ||
      Object.values(weights).some(v => !Number.isSafeInteger(v) || v < 0)) {
    throw new Error('weights non valido');
  }
  const w = Object.fromEntries(STRATEGIC.map(k => [k, weights[k] ?? 0]));
  const sum = Object.values(w).reduce((a,b) => a+b, 0);
  const maxStrategic = Math.min(maxCalls, sum, Math.max(0, maxCalls - Math.min(centerCount, maxCalls)));
  // Almeno una query trasporto per ogni centro, quando possibile; il residuo va alle categorie.
  const quotas = Object.fromEntries(STRATEGIC.map(k => [k, 0]));
  let assigned = 0;
  while (assigned < maxStrategic) {
    let changed = false;
    for (const k of STRATEGIC) {
      if (assigned >= maxStrategic) break;
      if (quotas[k] < w[k]) { quotas[k]++; assigned++; changed = true; }
    }
    if (!changed) break;
  }
  return { quotas, reserved: assigned, geographicBudget: maxCalls - assigned };
}

export async function comparePixelTerritorialDiscoveryV562(codiceIstat, {
  database = pool, maxGoogleCalls = 48, comparisonCenters = 40,
  weights = DEFAULT_WEIGHTS, ...territorialOptions
} = {}) {
  if (!/^\d{6}$/.test(String(codiceIstat))) throw new Error('Codice ISTAT non valido');
  if (!Number.isSafeInteger(comparisonCenters) || comparisonCenters < 0 || comparisonCenters > 500)
    throw new Error('comparisonCenters non valido');
  if (!Number.isSafeInteger(maxGoogleCalls) || maxGoogleCalls < 0 || maxGoogleCalls > 500)
    throw new Error('maxGoogleCalls non valido');
  // I due algoritmi ricevono identico numero di chiamate e nessuna quota strategica.
  const equalBudget = Math.min(comparisonCenters, maxGoogleCalls);
  const shared = { database, ...territorialOptions };
  const farthest = await planPixelTerritorialDiscovery(codiceIstat, { ...shared, maxGoogleCalls: equalBudget });
  const marginal = await planPixelTerritorialDiscoveryV561(codiceIstat, {
    ...shared, maxGoogleCalls: equalBudget, categoryQuotas: {},
  });
  if (farthest.centri_disponibili !== marginal.centri_disponibili)
    throw new Error('Numero centri incoerente tra i due piani');
  const allocation = allocatePixelV562Quotas(marginal.centri_disponibili, maxGoogleCalls, weights);
  const adaptive = await planPixelTerritorialDiscoveryV561(codiceIstat, {
    ...shared, maxGoogleCalls, categoryQuotas: allocation.quotas,
  });
  const coverageFarthest = farthest.copertura_geometrica_piano_pct;
  const coverageMarginal = marginal.copertura_geometrica_piano_pct;
  return {
    comune: String(codiceIstat), nome_comune: marginal.nome_comune,
    modalita: 'DRY_RUN', centri_disponibili: marginal.centri_disponibili,
    confronto_paritario: {
      budget: equalBudget,
      farthest_first: { centri: farthest.centri_esplorati, copertura_pct: coverageFarthest },
      marginal_gain: { centri: marginal.centri_esplorati, copertura_pct: coverageMarginal },
      differenza_marginal_vs_farthest_pp: round(coverageMarginal - coverageFarthest),
      vincitore_geometrico: Math.abs(coverageMarginal-coverageFarthest) < 0.0005 ? 'pari' :
        coverageMarginal > coverageFarthest ? 'marginal_gain' : 'farthest_first',
    },
    allocazione_adattiva: {
      ...allocation,
      centri_esplorati: adaptive.centri_esplorati,
      copertura_pct: adaptive.copertura_geometrica_piano_pct,
      chiamate: adaptive.chiamate_google_pianificate,
      categorie: adaptive.categorie,
      motivo_arresto: adaptive.motivo_arresto,
    },
    piano_adattivo: adaptive.piano,
    diagnostica: {
      nessuna_chiamata_google: true, nessuna_scrittura: true,
      centri_fuori_comune: Math.max(farthest.centri_fuori_comune, marginal.centri_fuori_comune, adaptive.centri_fuori_comune),
      avvertenza: 'Quote basate solo sul numero di centri, NON sulla presenza di stazioni o domanda. Copertura geometrica, NON fermate reali.',
    },
  };
}
