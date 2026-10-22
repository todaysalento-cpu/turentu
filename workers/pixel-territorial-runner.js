
import { pool } from '../db/db.js';
import {
  parsePixelTerritorialConfig,
  runPixelTerritorialCycle
} from '../services/pixel/pixel-territorial-runner.service.js';

async function main() {
  const config = parsePixelTerritorialConfig();

  const once = process.argv.includes('--once');
  const loop = process.argv.includes('--loop');

  if (!once && !loop) {
    throw new Error('Specificare --once oppure --loop');
  }

  async function execute() {
    const result = await runPixelTerritorialCycle(config);
    console.log('[PIXEL TERRITORIALE] ciclo completato', result);
  }

  if (once) {
    try {
      await execute();
    } finally {
      await pool.end();
    }
    return;
  }

  console.log('[PIXEL TERRITORIALE] runner periodico avviato');

  while (true) {
    await execute();
    await new Promise(resolve => setTimeout(resolve, 3600000));
  }
}

main().catch(error => {
  console.error('[PIXEL TERRITORIALE] errore fatale:', error);
  process.exitCode = 1;
});
