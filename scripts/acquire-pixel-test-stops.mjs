import { acquirePixelTestComune } from '../services/pixel/pixel-test-acquisition.service.js';
import { pool } from '../db/db.js';
const write = process.argv.includes('--write');
const istat = process.argv.find(a => /^\d{6}$/.test(a));
if (!['072006','073027'].includes(istat)) {
  console.error('Uso: node scripts/acquire-pixel-test-stops.mjs 072006|073027 [--write]');
  process.exitCode = 1;
} else {
  try {
    if (write) {
      if (process.env.PIXEL_TEST_MODE !== 'true') throw new Error('PIXEL_TEST_MODE deve essere true');
      if (!process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_')) throw new Error('Stripe non in modalità test');
      if (process.env.PIXEL_TEST_ACQUISITION_CONFIRM !== 'ACQUISISCI_OSM') throw new Error('Conferma esplicita mancante');
    }
    const result = await acquirePixelTestComune(istat, { write });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error('[PIXEL TEST]', error.message);
    process.exitCode = 1;
  }
}
await pool.end();
