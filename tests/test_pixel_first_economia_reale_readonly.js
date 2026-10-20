// Turentu — audit economico PIXEL-first, worker reale, prezzi invariati.
// Non esegue persistenza, non modifica il worker e non abilita il cutover.
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { pool } from '../db/db.js';

const assert = (ok, message) => { if (!ok) throw new Error('PIXEL_ECONOMIA_REALE: ' + message); };
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const workerFile = resolve(root, 'services/popbus/v2/worker.js');
let client;
let begun = false;
try {
  assert(process.env.POPBUS_PIXEL_FIRST !== '1', 'POPBUS_PIXEL_FIRST deve restare disabilitato');
  const worker = await readFile(workerFile, 'utf8');
  // Prima di importare/eseguire il worker controlliamo le garanzie del ramo diagnostico.
  const begin = worker.indexOf('async function diagnosticaFattibilitaPixelReadOnly()');
  const end = worker.indexOf('\nlet cicliAttivi', begin);
  assert(begin >= 0 && end > begin, 'ramo diagnostico del worker non riconosciuto');
  const diagnostic = worker.slice(begin, end);
  assert(diagnostic.includes("await client.query('BEGIN READ ONLY')"), 'manca BEGIN READ ONLY');
  assert(diagnostic.includes("await client.query('ROLLBACK')"), 'manca ROLLBACK');
  assert(diagnostic.includes('valutaEconomiaCiclo({'), 'calcolo economia reale non rilevato');
  assert(diagnostic.includes('kmAvvicinamento: approach.metres / 1000'), 'avvicinamento non rilevato');
  assert(diagnostic.includes('kmRitornoBase: returnTrip.metres / 1000'), 'ritorno non rilevato');
  assert(diagnostic.includes('f.selectedRequests.map(r => Number(r.prezzo))'), 'ricavi reali non rilevati');
  assert(!diagnostic.includes('Number(r.prezzo) * 1.5'), 'rilevato moltiplicatore di ricavi');
  assert(worker.includes('if (POPBUS_PIXEL_FEASIBILITY_READONLY) {'), 'gate READONLY non trovato');

  client = await pool.connect();
  await client.query('BEGIN READ ONLY'); begun = true;
  const { rows: [db] } = await client.query('SELECT current_database() AS nome');
  assert(db.nome === 'corse_db', 'database inatteso: ' + db.nome);
  const { rows: [fixture] } = await client.query(`SELECT
    (SELECT COUNT(*)::int FROM public.pixel_opportunita WHERE stato='candidata') AS opportunita,
    (SELECT COUNT(*)::int FROM public.richieste_pop_bus WHERE stato='in_attesa' AND corsa_id IS NULL) AS richieste`);
  console.log('PIXEL_ECONOMIA_REALE_PREFLIGHT_JSON:' + JSON.stringify({passed:true, db:db.nome, ...fixture, ricaviMoltiplicati:false}));
  await client.query('ROLLBACK'); begun = false;
  client.release(); client = null;

  // Processo isolato: chiama soltanto la diagnostica READ ONLY del worker reale.
  const childCode = `import { processaProposteDinamicheV2 } from './services/popbus/v2/worker.js'; await processaProposteDinamicheV2(); console.log('PIXEL_ECONOMIA_WORKER_RETURN_OK');`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', childCode], {
    cwd:root, encoding:'utf8', timeout:180000, maxBuffer:16*1024*1024,
    env:{...process.env, POPBUS_PIXEL_FIRST:'0', POPBUS_PIXEL_FEASIBILITY_READONLY:'1',
      POPBUS_PIXEL_SHADOW:'0', POPBUS_PIXEL_DB_SHADOW:'0', POPBUS_PIXEL_ADAPTER_SHADOW:'0',
      POPBUS_FLEET_SHADOW:'0', POPBUS_CYCLE_DIAGNOSTICS:'0'}
  });
  if (run.stdout) process.stdout.write(run.stdout);
  if (run.stderr) process.stderr.write(run.stderr);
  assert(!run.error && run.status === 0, 'worker non terminato correttamente: ' + (run.error?.message || run.status));
  assert(run.stdout.includes('PIXEL_ECONOMIA_WORKER_RETURN_OK'), 'manca marker di fine worker');
  const line = run.stdout.split(/\r?\n/).find(l => l.startsWith('PIXEL_FEASIBILITY_READONLY_JSON:'));
  assert(line, 'manca risultato diagnostico');
  const data = JSON.parse(line.slice('PIXEL_FEASIBILITY_READONLY_JSON:'.length));
  assert(Number.isInteger(data.formazioni) && Number.isInteger(data.fattibili) && Number.isInteger(data.selezionate), 'conteggi invalidi');
  assert(data.fattibili >= data.selezionate, 'selezionate > fattibili');
  assert(data.selezionate === (data.scelta?.length || 0), 'selezione incoerente');
  const ids = (data.scelta || []).flatMap(s => s.richiestaIds || []);
  assert(ids.length === new Set(ids.map(Number)).size, 'richieste duplicate nelle missioni');
  assert((data.scelta || []).every(s => s.ritornoIncluso === true && Number.isFinite(Number(s.margineEuro))), 'margini o ritorni invalidi');
  console.log('PIXEL_ECONOMIA_REALE_ESITO_JSON:' + JSON.stringify({
    passed:true, formazioni:data.formazioni, veicoli:data.veicoli ?? null,
    fattibili:data.fattibili, selezionate:data.selezionate,
    richiesteSelezionate:ids.length, scarti:data.scarti || {},
    decisione:data.selezionate ? 'CANDIDATI_ECONOMICI_PRESENTI' : 'NESSUNA_ATTIVAZIONE_ECONOMICA',
    note:'Il test diagnostico non persiste, non esegue COMMIT e non certifica il cutover.'
  }));
  console.log('PIXEL_ECONOMIA_REALE_READONLY_OK');
} catch (error) {
  console.error('PIXEL_ECONOMIA_REALE_ERROR:', error.stack || error.message);
  process.exitCode = 1;
} finally {
  if (begun && client) await client.query('ROLLBACK').catch(e => {console.error('ROLLBACK_ERROR:', e.message);process.exitCode=1;});
  client?.release();
  await pool.end();
}
