// tests/test_pixel_territorial_adaptive_v55.js
import { generatePixelAdaptiveCenters } from '../services/pixel/pixel-territorial-adaptive.service.js';
import { pool } from '../db/db.js';

try {
  for (const codice of ['072006', '075035']) {
    const risultato = await generatePixelAdaptiveCenters(codice, {
      gridStepMeters: 3000,
      searchRadiusMeters: 1500,
      minComponentAreaM2: 100000,
      maxAdditionalCenters: 10,
      minMarginalGainM2: 10000,
    });
    console.log(JSON.stringify(risultato, null, 2));
  }
} catch (error) {
  console.error('TEST ADATTIVO V5.5 FALLITO:', error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
