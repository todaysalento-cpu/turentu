// Turentu PIXEL-first: dettaglio delle valutazioni economiche del worker reale.
// Nessuna modifica ai file applicativi o al DB. Worker caricato strumentato IN MEMORIA.
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const workerPath = resolve(root, 'services/popbus/v2/worker.js');
const assert = (condition, message) => { if (!condition) throw new Error(message); };
try {
  assert(process.env.POPBUS_PIXEL_FIRST !== '1', 'POPBUS_PIXEL_FIRST deve restare a 0');
  let source = await readFile(workerPath, 'utf8');
  const start = source.indexOf('async function diagnosticaFattibilitaPixelReadOnly()');
  const end = source.indexOf('\nlet cicliAttivi', start);
  assert(start >= 0 && end > start, 'Funzione diagnostica non riconosciuta');
  let before = source.slice(0, start);
  let diag = source.slice(start, end);
  let after = source.slice(end);
  assert(diag.includes("await client.query('BEGIN READ ONLY')") && diag.includes("await client.query('ROLLBACK')"), 'Transazione read-only non garantita');
  assert(diag.includes('valutaEconomiaCiclo({') && diag.includes('kmRitornoBase: returnTrip.metres / 1000'), 'Economia reale / ritorno non riconosciuti');
  assert(diag.includes('f.selectedRequests.map(r => Number(r.prezzo))'), 'Ricavi reali non riconosciuti');
  const needle = "if (!economia.economicamenteAttivabile) { skip('soglia_economica'); continue; }";
  assert(diag.includes(needle), 'Punto di strumentazione non riconosciuto');
  const collector = `
    const __pixelEconomiaScartate = [];
`;
  diag = diag.replace('const feasible = [];', 'const feasible = [];'+collector);
  diag = diag.replace(needle, `if (!economia.economicamenteAttivabile) {
          __pixelEconomiaScartate.push({
            opportunitaId: f.pixelOpportunitaId,
            veicoloId: Number(vehicle.id),
            richieste: f.selectedRequests.map(r => Number(r.id)),
            tariffaEuroKm: Number(vehicle.euro_km),
            ricavoLordoEuro: economia.ricavoLordoEuro,
            commissioneTurentuEuro: economia.commissioneTurentuEuro,
            ricavoNettoEuro: economia.ricavoNettoEuro,
            km: economia.km,
            costoKmEuro: economia.costoKmEuro,
            costoAttesaEuro: economia.costoAttesaEuro,
            altriCostiEuro: economia.altriCostiEuro,
            costoCompletoEuro: economia.costoCompletoEuro,
            margineEuro: economia.margineEuro,
            margineMinimoEuro: economia.margineMinimoEuro,
            sogliaAttivazioneLordaEuro: economia.sogliaAttivazioneLordaEuro,
            deficitLordoEuro: Math.max(0, Math.round((economia.sogliaAttivazioneLordaEuro - economia.ricavoLordoEuro) * 100) / 100)
          });
          skip('soglia_economica'); continue;
        }`);
  const marker = "const chosen = scegliAttivazioni(feasible);";
  assert(diag.includes(marker), 'Selettore non riconosciuto');
  diag = diag.replace(marker, `__pixelEconomiaScartate.sort((a,b) => a.deficitLordoEuro - b.deficitLordoEuro || b.margineEuro - a.margineEuro);
    console.log('PIXEL_ECONOMIA_DETTAGLIO_JSON:' + JSON.stringify({
      scartiEconomici: __pixelEconomiaScartate.length,
      migliori: __pixelEconomiaScartate.slice(0, 20),
      nota: 'Scarti per soglia; dati del worker reale, nessuna modifica alle decisioni'
    }));
    ${marker}`);
  source = before + diag + after;
  // Le importazioni relative vengono risolte rispetto al worker originale.
  const workerDir = dirname(workerPath);
  source = source.replace(/(from\s*['"])(\.{1,2}\/[^'"]+)(['"])/g,
    (_m, a, relative, z) => a + pathToFileURL(resolve(workerDir, relative)).href + z);
  const code = `const src = ${JSON.stringify(source)};
    const url = 'data:text/javascript;base64,' + Buffer.from(src).toString('base64');
    const worker = await import(url);
    await worker.processaProposteDinamicheV2();
    console.log('PIXEL_ECONOMIA_DETTAGLIO_WORKER_OK');`;
  // Windows: non passare il sorgente via -e (ENAMETOOLONG).
  const tempDir = await mkdtemp(join(tmpdir(), 'turentu-pixel-economia-'));
  const runnerPath = join(tempDir, 'runner.mjs');
  let child;
  try {
    await writeFile(runnerPath, code, 'utf8');
    child = spawnSync(process.execPath, [runnerPath], {
    cwd: root, encoding: 'utf8', timeout: 180000, maxBuffer: 20 * 1024 * 1024,
    env: {...process.env, POPBUS_PIXEL_FIRST:'0', POPBUS_PIXEL_FEASIBILITY_READONLY:'1',
      POPBUS_PIXEL_SHADOW:'0', POPBUS_PIXEL_DB_SHADOW:'0', POPBUS_PIXEL_ADAPTER_SHADOW:'0',
      POPBUS_FLEET_SHADOW:'0', POPBUS_CYCLE_DIAGNOSTICS:'0'}
    });
  } finally {
    await rm(tempDir, {recursive:true, force:true});
  }
  if (child.stderr) process.stderr.write(child.stderr);
  assert(!child.error && child.status === 0, 'Worker fallito: ' + (child.error?.message || child.status));
  const line = child.stdout.split(/\r?\n/).find(x => x.startsWith('PIXEL_ECONOMIA_DETTAGLIO_JSON:'));
  const counts = child.stdout.split(/\r?\n/).find(x => x.startsWith('PIXEL_FEASIBILITY_READONLY_JSON:'));
  assert(line && counts && child.stdout.includes('PIXEL_ECONOMIA_DETTAGLIO_WORKER_OK'), 'Output incompleto');
  const data = JSON.parse(line.split('PIXEL_ECONOMIA_DETTAGLIO_JSON:')[1]);
  const summary = JSON.parse(counts.split('PIXEL_FEASIBILITY_READONLY_JSON:')[1]);
  assert(data.scartiEconomici === (summary.scarti?.soglia_economica || 0), 'Numero scarti diverso dal worker');
  assert(data.migliori.every(x => x.km.ritornoBase >= 0 && x.km.avvicinamento >= 0 && x.deficitLordoEuro > 0), 'Dettagli non validi');
  console.log(line);
  console.log(counts);
  console.log('PIXEL_ECONOMIA_DETTAGLIO_READONLY_OK');
} catch (e) {
  console.error('PIXEL_ECONOMIA_DETTAGLIO_ERROR:', e.stack || e.message);
  process.exitCode = 1;
}
