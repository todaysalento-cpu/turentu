
// tests/test_pixel_territorial_discovery_v563.js
import { comparePixelTerritorialDiscoveryV563 } from '../services/pixel/pixel-territorial-discovery-plan-v563.service.js';

const comuni = [{ codice: '072006', nome: 'BARI' }, { codice: '075035', nome: 'LECCE' }];
let failed = false;
for (const { codice, nome } of comuni) {
  console.log(`\n========== ${nome} (${codice}) ==========`);
  try {
    const result = await comparePixelTerritorialDiscoveryV563(codice, {
      maxGoogleCalls: 48, strategicReserves: [0, 2, 4, 8],
    });
    console.table(result.scenari.map(s => ({
      riserva: s.riserva_effettiva,
      centri: s.centri_esplorati,
      copertura_pct: s.copertura_pct,
      differenza_pp: s.differenza_vs_senza_quote_pp,
      chiamate: s.chiamate,
      strategiche: s.chiamate_strategiche,
      non_usate: s.chiamate_non_usate,
      durata_ms: s.durata_ms,
    })));
    for (const scenario of result.scenari) {
      const errors = Object.entries(scenario.verifiche).filter(([, ok]) => !ok).map(([k]) => k);
      if (errors.length) { failed = true; console.error('VERIFICHE FALLITE:', errors, 'riserva', scenario.riserva_richiesta); }
    }
    console.log(result.avvertenza);
  } catch (err) { failed = true; console.error(`${nome}:`, err.stack ?? err); }
}
console.log(failed ? '\nESITO: FALLITO' : '\nESITO: VERIFICHE OK');
if (failed) process.exitCode = 1;
