// TURENTU — test E2E corretto del ramo diagnostico REALE del worker PIXEL-first.
// Copia temporanea del worker: originale INALTERATO; ricavi x1.50 solo in memoria.
// Database: BEGIN READ ONLY + ROLLBACK nel worker. Nessuna attivazione.
// Richiede POPBUS_WORKER_E2E_CONFIRM=CORSE_DB_TEST e POPBUS_PIXEL_FIRST=0.
import { existsSync } from 'node:fs';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const fail = msg => { throw new Error('PIXEL_WORKER_E2E: ' + msg); };
const marker = 'PIXEL_FEASIBILITY_READONLY_JSON:';
const root = process.cwd();
const workerPath = resolve(root, 'services/popbus/v2/worker.js');
const factor = 1.5;

if (process.env.POPBUS_WORKER_E2E_CHILD === '1') {
  // In un processo isolato: importa la COPIA del worker con gli stessi import relativi.
  const workerCopy = process.env.POPBUS_WORKER_E2E_COPY;
  if (!workerCopy || !existsSync(workerCopy)) fail('copia worker assente');
  const { processaProposteDinamicheV2 } = await import(pathToFileURL(workerCopy).href);
  if (typeof processaProposteDinamicheV2 !== 'function') fail('export worker assente');
  await processaProposteDinamicheV2();
  console.log('PIXEL_WORKER_E2E_ROLLBACK_OK: ramo diagnostico terminato (finally ROLLBACK)');
} else {
  if (process.env.POPBUS_WORKER_E2E_CONFIRM !== 'CORSE_DB_TEST')
    fail('richiesta conferma POPBUS_WORKER_E2E_CONFIRM=CORSE_DB_TEST');
  if (process.env.POPBUS_PIXEL_FIRST === '1') fail('POPBUS_PIXEL_FIRST deve essere 0');
  if (!existsSync(workerPath)) fail('worker non trovato: ' + workerPath);
  // Il controllo DB avviene PRIMA di scrivere qualsiasi copia del worker.
  const { pool } = await import(pathToFileURL(resolve(root, 'db/db.js')).href);
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const db = (await client.query('SELECT current_database() AS db')).rows[0].db;
    if (db !== 'corse_db') fail('DB inatteso: ' + db);
    const r = (await client.query(`SELECT
      (SELECT count(*)::int FROM public.pixel_opportunita WHERE stato='candidata') AS opportunita,
      (SELECT count(*)::int FROM public.richieste_pop_bus WHERE stato='in_attesa' AND corsa_id IS NULL) AS richieste`)).rows[0];
    if (r.opportunita < 2 || r.richieste < 12) fail('fixture PIXEL insufficiente: ' + JSON.stringify(r));
    console.log('PIXEL_WORKER_E2E_PREFLIGHT_JSON:' + JSON.stringify({db, ...r, factor}));
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
  const original = await readFile(workerPath, 'utf8');
  // La sostituzione e' limitata alla funzione diagnostica READ ONLY.
  const start = original.indexOf('async function diagnosticaFattibilitaPixelReadOnly()');
  const end = original.indexOf('\nlet cicliAttivi', start);
  if (start < 0 || end < 0) fail('confini diagnostica worker non trovati');
  const before = original.slice(0, start);
  const diagnostic = original.slice(start, end);
  const after = original.slice(end);
  const exact = 'ricaviRichiesteEuro: f.selectedRequests.map(r => Number(r.prezzo)),';
  if (diagnostic.split(exact).length !== 2) fail('punto di iniezione ricavi non univoco');
  if (!diagnostic.includes("await client.query('BEGIN READ ONLY')") ||
      !diagnostic.includes("await client.query('ROLLBACK')") ||
      !diagnostic.includes('const chosen = scegliAttivazioni(feasible);') ||
      !diagnostic.includes('await conflittiVeicolo(client, vehicle.id, busyStart, busyEnd)'))
    fail('invarianti di sicurezza worker non presenti');
  // Contratto completo richiesto da economiaCandidato() nel selettore reale.
  const pushMarker = `        feasible.push({
          source: 'PIXEL', pixelOpportunitaId: f.pixelOpportunitaId,`;
  const evalMarker = `          plan, evaluation, vehicle, approach, returnTrip, busyStart, busyEnd,`;
  if (diagnostic.split(pushMarker).length !== 2 || diagnostic.split(evalMarker).length !== 2)
    fail('contratto candidato worker inatteso: interruzione fail-closed');
  const revenueExpression = `f.selectedRequests.map(r => Number(r.prezzo) * ${factor})`;
  const patchedDiagnostic = diagnostic
    .replace(exact, `ricaviRichiesteEuro: ${revenueExpression},`)
    .replace(pushMarker, `        feasible.push({
          ricaviRichiesteEuro: ${revenueExpression},
          source: 'PIXEL', pixelOpportunitaId: f.pixelOpportunitaId,`)
    .replace(evalMarker, `          plan, evaluation: { ...evaluation, revenue: economia.ricavoLordoEuro }, vehicle, approach, returnTrip, busyStart, busyEnd,`);
  const patched = before + patchedDiagnostic + after;
  const copy = join(dirname(workerPath), `.worker-pixel-e2e-${randomUUID()}.js`);
  try {
    await writeFile(copy, patched, {flag:'wx', mode:0o600});
    const child = spawnSync(process.execPath, [process.argv[1]], {
      cwd: root, encoding:'utf8', timeout:180000, maxBuffer:16*1024*1024,
      env:{...process.env,
        POPBUS_WORKER_E2E_CHILD:'1', POPBUS_WORKER_E2E_COPY:copy,
        POPBUS_PIXEL_FIRST:'0', POPBUS_PIXEL_FEASIBILITY_READONLY:'1',
        POPBUS_PIXEL_SHADOW:'0', POPBUS_PIXEL_DB_SHADOW:'0',
        POPBUS_PIXEL_ADAPTER_SHADOW:'0', POPBUS_FLEET_SHADOW:'0',
        POPBUS_CYCLE_DIAGNOSTICS:'0'}
    });
    if (child.stdout) process.stdout.write(child.stdout);
    if (child.stderr) process.stderr.write(child.stderr);
    if (child.status !== 0 || child.error) fail('worker child fallito: ' + (child.error?.message || child.status));
    const lines = child.stdout.split(/\r?\n/);
    const raw = lines.find(l => l.startsWith(marker));
    if (!raw || !lines.some(l => l.startsWith('PIXEL_WORKER_E2E_ROLLBACK_OK:')))
      fail('marker diagnostica o rollback mancante');
    const data = JSON.parse(raw.slice(marker.length));
    const selected = data.scelta || [];
    const ids = selected.flatMap(s => (s.richiestaIds || []).map(Number));
    const uniqueRequests = new Set(ids).size === ids.length;
    const economicallyFeasible = data.fattibili > 0 && selected.length > 0;
    const result = {
      source:'worker_diagnostico_reale', multiplier:factor,
      formazioni:data.formazioni, veicoli:data.veicoli,
      candidatiEconomici:data.fattibili, missioniSelezionate:data.selezionate,
      richiesteServite:ids.length, uniqueRequests,
      economicamenteFattibili:economicallyFeasible,
      scarti:data.scarti, scelte:selected,
      passed: economicallyFeasible && uniqueRequests && selected.length >= 2 && ids.length >= 12,
      limiti:['Non attiva o persiste missioni',
        'Conflitti DB verificati dal worker ma non necessariamente presenti nella fixture',
        'Non dimostra ottimalita globale o cutover operativo']
    };
    console.log('PIXEL_WORKER_E2E_SIMULATO_JSON:' + JSON.stringify(result));
    if (!result.passed) fail('risultato sotto le attese; consultare JSON e scarti');
  } finally {
    await unlink(copy).catch(e => console.error('ATTENZIONE: eliminare copia temporanea:',copy,e.message));
  }
}
