// tests/test_pixel_territorial_policy_v552.js
// Diagnostica in sola lettura: confronta V5.5.2 con i risultati V5.5.1.
import { generatePixelAdaptiveCenters } from '../services/pixel/pixel-territorial-adaptive.service.js';

const comuni = [
  { codice: '072006', nome: 'Bari', base: 90.036, precedente10: 98.858 },
  { codice: '075035', nome: 'Lecce', base: 87.857, precedente10: 95.141 },
];
const opts = {
  gridStepMeters: 3000,
  searchRadiusMeters: 1500,
  minComponentAreaM2: 100000,
  minCenterDistanceMeters: 500,
  maxAdditionalCenters: 30,
  minMarginalGainM2: 100000,
  targetCoveragePercent: 98,
};

for (const c of comuni) {
  console.log(`\n========== ${c.nome.toUpperCase()} (${c.codice}) ==========`);
  const start = performance.now();
  const r = await generatePixelAdaptiveCenters(c.codice, opts);
  const durata = Math.round(performance.now() - start);
  const somma = r.centri.reduce((s, x) => s + x.guadagno_km2, 0);
  const delta = Math.abs(somma - r.superficie_recuperata_km2);
  const invariata = Math.abs(r.copertura_base_percentuale - c.base) < 0.005;
  const coerente = delta <= 0.006;
  const soglie = r.centri.every(x => x.guadagno_km2 + 0.00005 >= opts.minMarginalGainM2 / 1e6);
  const target = r.copertura_finale_percentuale >= opts.targetCoveragePercent - 0.001;
  const motivoCoerente = r.motivo_arresto !== 'copertura_obiettivo' || target;
  console.log(JSON.stringify({
    comune: r.nome_comune,
    centri_base: r.centri_base,
    centri_aggiunti: r.centri_aggiunti,
    centri_totali: r.centri_base + r.centri_aggiunti,
    copertura_base_pct: r.copertura_base_percentuale,
    copertura_finale_pct: r.copertura_finale_percentuale,
    obiettivo_pct: r.copertura_obiettivo_percentuale,
    recupero_km2: r.superficie_recuperata_km2,
    residuo_km2: r.superficie_residua_km2,
    ultimo_guadagno_km2: r.centri.at(-1)?.guadagno_km2 ?? null,
    motivo_arresto: r.motivo_arresto,
    query_sql: r.diagnostica_adattiva.query_eseguite,
    durata_ms: durata,
    verifiche: {
      base_invariata: invariata ? 'OK' : 'ERRORE',
      somma_guadagni: coerente ? 'OK' : 'ERRORE',
      soglia_guadagni: soglie ? 'OK' : 'ERRORE',
      motivo_obiettivo: motivoCoerente ? 'OK' : 'ERRORE',
    },
  }, null, 2));
  console.log('Guadagni marginali (km2):', r.centri.map(x => x.guadagno_km2).join(', '));
  if (!invariata || !coerente || !soglie || !motivoCoerente) process.exitCode = 1;
}
