// tests/test_pixel_territorial_exploration_v55.js
import { generatePixelTerritorialCenters } from '../services/pixel/pixel-territorial-exploration.service.js';
import { pool } from '../db/db.js';

try {
  for (const codice of ['072006', '075035']) {
    const result = await generatePixelTerritorialCenters(codice);
    console.log(JSON.stringify({
      comune: result.comune, nome: result.nome_comune,
      centri: result.centri_totali, superficie_km2: result.superficie_amministrativa_km2,
      area_celle_utm_km2: result.area_celle_utm_km2,
      nodi_attivi: result.nodi_attivi,
      celle_piccole: result.centri.filter(c => c.frazione_cella < 0.1).length,
      centri_lontani_3km: result.centri.filter(c => c.distanza_nodo_m > 3000).length,
      esempio: result.centri.slice(0, 3),
    }, null, 2));
  }
} catch (err) {
  console.error('TEST V5.5 FALLITO:', err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
