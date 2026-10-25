// tests/test_pixel_territorial_sensitivity_v551.js
// PIXEL V5.5.1 - Test sensibilita' 5 / 10 / 20 centri.
// SOLO SELECT, nessuna API Google, nessuna modifica ai servizi.
import { generatePixelAdaptiveCenters } from '../services/pixel/pixel-territorial-adaptive.service.js';
import { pool } from '../db/db.js';

const COMUNI = ['072006', '075035'];
const LIMITI = [5, 10, 20];
const BASE_OPTIONS = {
  gridStepMeters: 3000,
  searchRadiusMeters: 1500,
  minComponentAreaM2: 100000,
  minMarginalGainM2: 10000,
};

const round = (n, digits = 3) => Number(Number(n).toFixed(digits));

async function main() {
  for (const codice of COMUNI) {
    console.log(`\n========== COMUNE ${codice} ==========`);
    const risultati = [];
    for (const limite of LIMITI) {
      const start = performance.now();
      const r = await generatePixelAdaptiveCenters(codice, {
        ...BASE_OPTIONS,
        maxAdditionalCenters: limite,
      });
      const durataMs = round(performance.now() - start, 0);
      const guadagni = r.centri.map(c => Number(c.guadagno_km2));
      const recuperoSomma = guadagni.reduce((a, b) => a + b, 0);
      const differenza = Math.abs(recuperoSomma - Number(r.superficie_recuperata_km2));
      const item = {
        limite,
        centri_base: r.centri_base,
        centri_aggiunti: r.centri_aggiunti,
        centri_totali: r.centri_base + r.centri_aggiunti,
        copertura_base_pct: r.copertura_base_percentuale,
        copertura_finale_pct: r.copertura_finale_percentuale,
        recupero_km2: r.superficie_recuperata_km2,
        residuo_km2: r.superficie_residua_km2,
        ultimo_guadagno_km2: guadagni.length ? guadagni[guadagni.length - 1] : null,
        query_sql: r.diagnostica_adattiva?.query_eseguite ?? null,
        motivo_arresto: r.motivo_arresto,
        durata_ms: durataMs,
        verifica_somma_guadagni: differenza <= 0.003 ? 'OK' : `VERIFICARE: differenza ${round(differenza, 4)} km2`,
      };
      risultati.push(item);
      console.log(`\nLimite ${limite}:`);
      console.log(JSON.stringify(item, null, 2));
      console.log('Guadagni marginali (km2):', guadagni.join(', '));
    }
    console.log('\nRIEPILOGO');
    console.table(risultati);
    const [a, b, c] = risultati;
    console.log('Incremento copertura 5 -> 10 (punti percentuali):', round(b.copertura_finale_pct - a.copertura_finale_pct));
    console.log('Incremento copertura 10 -> 20 (punti percentuali):', round(c.copertura_finale_pct - b.copertura_finale_pct));
    if (b.copertura_finale_pct + 0.001 < a.copertura_finale_pct || c.copertura_finale_pct + 0.001 < b.copertura_finale_pct) {
      console.warn('ATTENZIONE: copertura non monotona, verificare implementazione');
    }
  }
}

main()
  .catch(err => { console.error('TEST FALLITO:', err); process.exitCode = 1; })
  .finally(async () => { await pool.end(); });
