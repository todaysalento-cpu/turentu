// tests/test_pixel_territorial_adaptive_v551.js
import { generatePixelAdaptiveCenters } from '../services/pixel/pixel-territorial-adaptive.service.js';

for (const codice of ['072006', '075035']) {
  const result = await generatePixelAdaptiveCenters(codice, {
    gridStepMeters: 3000,
    searchRadiusMeters: 1500,
    minComponentAreaM2: 100000,
    maxAdditionalCenters: 10,
    minMarginalGainM2: 10000,
    minCenterDistanceMeters: 500,
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.copertura_finale_percentuale + 0.001 < result.copertura_base_percentuale) {
    throw new Error(`Copertura diminuita per ${codice}`);
  }
  if (result.centri_aggiunti > 10) throw new Error('Superato il limite centri');
  for (const c of result.centri) {
    if (c.guadagno_km2 <= 0) throw new Error('Guadagno non positivo');
  }
}
