// TURENTU - E2E PIXEL -> POPBUS V2, SOLO LETTURA.
// Eseguire esclusivamente su un database di collaudo.
// Il worker apre BEGIN READ ONLY e termina con ROLLBACK.
// Nessun import del worker finche' non sono state verificate le protezioni.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

if (process.env.POPBUS_E2E_READONLY_CONFIRM !== 'SI') {
  console.error('BLOCCATO: impostare POPBUS_E2E_READONLY_CONFIRM=SI solo su database di collaudo');
  process.exitCode = 2;
} else if (process.env.POPBUS_PIXEL_FIRST === '1') {
  console.error('BLOCCATO: POPBUS_PIXEL_FIRST deve restare disabilitato');
  process.exitCode = 2;
} else {
  const root = process.cwd();
  const worker = resolve(root, 'services/popbus/v2/worker.js');
  const required = [
    worker,
    resolve(root, 'services/popbus/v2/pixel-worker-formation-source.js'),
    resolve(root, 'services/popbus/v2/pixel-worker-feasibility-bridge.js')
  ];
  const missing = required.filter(p => !existsSync(p));
  if (missing.length) {
    console.error('BLOCCATO: file mancanti:\n' + missing.join('\n'));
    process.exitCode = 2;
  } else {
    process.env.POPBUS_PIXEL_FIRST = '0';
    process.env.POPBUS_PIXEL_FEASIBILITY_READONLY = '1';
    // Nessun ramo diagnostico parallelo o generatore legacy richiesto.
    process.env.POPBUS_PIXEL_SHADOW = '0';
    process.env.POPBUS_PIXEL_DB_SHADOW = '0';
    process.env.POPBUS_PIXEL_ADAPTER_SHADOW = '0';
    process.env.POPBUS_FLEET_SHADOW = '0';
    process.env.POPBUS_CYCLE_DIAGNOSTICS = '0';
    const started = Date.now();
    console.log('E2E PIXEL READONLY START - verificare che il DB sia di collaudo');
    try {
      const mod = await import(pathToFileURL(worker).href);
      if (typeof mod.processaProposteDinamicheV2 !== 'function') {
        throw new Error('Export processaProposteDinamicheV2 mancante');
      }
      await mod.processaProposteDinamicheV2();
      console.log(`E2E PIXEL READONLY END - durata ${Date.now() - started} ms`);
      console.log('ATTENZIONE: esecuzione completata non equivale ad attivazione operativa');
    } catch (error) {
      console.error('E2E PIXEL READONLY ERROR:', error.stack || error.message);
      process.exitCode = 1;
    }
  }
}
