// TURENTU — E2E diagnostico: esclusivita' per veicolo, non per titolare.
// Scenario A: baseline; Scenario B: conflitto SIMULATO su veicolo 361.
// Il conflitto e' iniettato SOLO nella copia temporanea del worker.
// Entrambi i run eseguono BEGIN READ ONLY / ROLLBACK. Nessuna scrittura DB.
// Eseguire esclusivamente su DB di collaudo corse_db.
import { existsSync } from 'node:fs';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const fail = m => { throw new Error('PIXEL_CONFLITTO_TEST: ' + m); };
const root = process.cwd();
const workerPath = resolve(root, 'services/popbus/v2/worker.js');
const factor = 1.5;
const blockedVehicle = 361;
const otherVehicle = 363;
const marker = 'PIXEL_FEASIBILITY_READONLY_JSON:';

if (process.env.PIXEL_CONFLITTO_CHILD === '1') {
  const copy = process.env.PIXEL_CONFLITTO_COPY;
  if (!copy || !existsSync(copy)) fail('copia worker non disponibile');
  const { processaProposteDinamicheV2 } = await import(pathToFileURL(copy).href);
  await processaProposteDinamicheV2();
  console.log('PIXEL_CONFLITTO_ROLLBACK_OK: diagnostica terminata con ROLLBACK nel finally');
} else {
  if (process.env.POPBUS_WORKER_E2E_CONFIRM !== 'CORSE_DB_TEST') fail('impostare POPBUS_WORKER_E2E_CONFIRM=CORSE_DB_TEST');
  if (process.env.POPBUS_PIXEL_FIRST === '1') fail('POPBUS_PIXEL_FIRST deve essere 0');
  if (!existsSync(workerPath)) fail('worker.js non trovato');

  const { pool } = await import(pathToFileURL(resolve(root, 'db/db.js')).href);
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const db = (await client.query('SELECT current_database() AS db')).rows[0].db;
    if (db !== 'corse_db') fail('database inatteso: ' + db);
    const rows = (await client.query('SELECT id, driver_id FROM veicolo WHERE id=ANY($1::int[]) ORDER BY id', [[blockedVehicle, otherVehicle]])).rows;
    if (rows.length !== 2 || Number(rows[0].driver_id) !== Number(rows[1].driver_id))
      fail('fixture: veicoli 361 e 363 non appartengono allo stesso titolare');
    console.log('PIXEL_CONFLITTO_PREFLIGHT_JSON:' + JSON.stringify({db, veicoli:rows, multiplier:factor}));
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }

  const original = await readFile(workerPath, 'utf8');
  const start = original.indexOf('async function diagnosticaFattibilitaPixelReadOnly()');
  const end = original.indexOf('\nlet cicliAttivi', start);
  if (start < 0 || end < 0) fail('confini della diagnostica non trovati');
  const diagnostic = original.slice(start, end);
  if (!diagnostic.includes("await client.query('BEGIN READ ONLY')") ||
      !diagnostic.includes("await client.query('ROLLBACK')") ||
      !diagnostic.includes('const chosen = scegliAttivazioni(feasible);'))
    fail('guardie di sicurezza assenti');
  const revenueMarker = 'const ricaviRichiesteEuro = f.selectedRequests.map(r => Number(r.prezzo));';
  const conflictMarker = 'if ((await conflittiVeicolo(client, vehicle.id, busyStart, busyEnd)).length) {';
  if (diagnostic.split(revenueMarker).length !== 2 || diagnostic.split(conflictMarker).length !== 2)
    fail('worker non corrisponde alla versione con contratto economico corretto');

  async function runScenario(scenario, block) {
    const injected = diagnostic
      .replace(revenueMarker, `const ricaviRichiesteEuro = f.selectedRequests.map(r => Number(r.prezzo) * ${factor});`)
      .replace(conflictMarker, `if ((await conflittiVeicolo(client, vehicle.id, busyStart, busyEnd)).length || (${block ? 'true' : 'false'} && Number(vehicle.id) === ${blockedVehicle})) {`);
    const copy = join(dirname(workerPath), `.worker-pixel-conflict-${randomUUID()}.js`);
    try {
      await writeFile(copy, original.slice(0, start) + injected + original.slice(end), {flag:'wx',mode:0o600});
      const child = spawnSync(process.execPath, [resolve(root, 'tests/test_pixel_worker_conflitto_veicolo_readonly.js')], {
        cwd:root, encoding:'utf8', timeout:180000, maxBuffer:16*1024*1024,
        env:{...process.env, PIXEL_CONFLITTO_CHILD:'1', PIXEL_CONFLITTO_COPY:copy,
          POPBUS_PIXEL_FIRST:'0', POPBUS_PIXEL_FEASIBILITY_READONLY:'1',
          POPBUS_PIXEL_SHADOW:'0', POPBUS_PIXEL_DB_SHADOW:'0',
          POPBUS_PIXEL_ADAPTER_SHADOW:'0', POPBUS_FLEET_SHADOW:'0',
          POPBUS_CYCLE_DIAGNOSTICS:'0'}
      });
      if (child.stderr) process.stderr.write(child.stderr);
      if (child.error || child.status !== 0) fail(`${scenario}: worker fallito (${child.error?.message || child.status})`);
      const lines = child.stdout.split(/\r?\n/);
      const line = lines.find(l => l.startsWith(marker));
      if (!line || !lines.some(l => l.startsWith('PIXEL_CONFLITTO_ROLLBACK_OK:')))
        fail(`${scenario}: manca output diagnostico o conferma rollback`);
      const data = JSON.parse(line.slice(marker.length));
      const selected = data.scelta || [];
      const ids = selected.flatMap(x => x.richiestaIds || []);
      const result = {
        scenario, conflittoSimulato: block ? blockedVehicle : null,
        formazioni:data.formazioni, candidatiEconomici:data.fattibili,
        missioniSelezionate:data.selezionate, richiesteServite:ids.length,
        veicoliSelezionati:selected.map(x=>Number(x.veicoloId)),
        richiesteUniche:new Set(ids.map(Number)).size === ids.length,
        scarti:data.scarti, scelte:selected
      };
      console.log('PIXEL_CONFLITTO_SCENARIO_JSON:' + JSON.stringify(result));
      return result;
    } finally {
      await unlink(copy).catch(e => console.error('RIMUOVERE COPIA TEMPORANEA:',copy,e.message));
    }
  }

  const base = await runScenario('BASELINE', false);
  const blocked = await runScenario('VEICOLO_361_OCCUPATO_SIMULATO', true);
  const assertions = {
    baseline361:base.veicoliSelezionati.includes(blockedVehicle),
    baseline363:base.veicoliSelezionati.includes(otherVehicle),
    blocked361Absent:!blocked.veicoliSelezionati.includes(blockedVehicle),
    blocked363Present:blocked.veicoliSelezionati.includes(otherVehicle),
    conflictDetected:(blocked.scarti?.conflitto_veicolo || 0) > (base.scarti?.conflitto_veicolo || 0),
    uniqueRequests:base.richiesteUniche && blocked.richiesteUniche,
    rollback:true
  };
  const passed=Object.values(assertions).every(Boolean);
  console.log('PIXEL_CONFLITTO_VERDETTO_JSON:' + JSON.stringify({passed, assertions,
    nota:'Conflitto iniettato in memoria; NON certifica ancora un conflitto persistito nel DB'}));
  if (!passed) fail('invarianti non soddisfatte: esaminare i due scenari');
}
