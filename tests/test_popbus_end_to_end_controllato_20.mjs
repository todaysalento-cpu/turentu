// TURENTU POPBUS — TEST 20: SHADOW E2E CONTROLLATO -> OTTIMIZZATORE REALE -> PERSISTENZA SQL MOCK
// SOLA LETTURA: non importa worker.js, non apre DB, non esegue Stripe/socket/cron.
// Salva come tests/test_popbus_worker_pixel_end_to_end_10.mjs
// Esegui da root: node tests/test_popbus_worker_pixel_end_to_end_10.mjs
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const paths = {
  optimizer: path.join(root, 'services/popbus/v2/fleet-optimizer.js'),
  persistence: path.join(root, 'services/popbus/v2/popbus-cycle-persistence.js'),
  acceptance: path.join(root, 'services/popbus/v2/acceptance.js'),
  worker: path.join(root, 'services/popbus/v2/worker.js'),
  adapter: path.join(root, 'services/pixel/pixel-popbus-cycle-adapter.js'),
  assembler: path.join(root, 'services/popbus/v2/popbus-single-corsa-assembler.js')
};
let pass = 0, fail = 0;
const check = (condition, message, detail = '') => {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${message}${detail ? ' — ' + detail : ''}`);
  condition ? pass++ : fail++;
};
const leg = (metres = 10000, seconds = 1800) => ({
  metres, seconds, polyline: '_p~iF~ps|U_ulLnnqC', roadVerified: true
});
const t0 = Date.parse('2027-04-01T08:00:00.000Z');
const nodes = [
  { id: 7, lat: 40.3515, lon: 18.1750, nome_nodo: 'Lecce' },
  { id: 5, lat: 40.1200, lon: 18.2900, nome_nodo: 'Maglie' },
  { id: 8, lat: 39.9300, lon: 18.3500, nome_nodo: 'Tricase' }
];
const requests = [
  { id: 101, start_node_id: 7, end_node_id: 5, start_datetime: new Date(t0).toISOString(), posti_richiesti: 2, prezzo: 90, classe: 'STANDARD' },
  { id: 102, start_node_id: 5, end_node_id: 8, start_datetime: new Date(t0 + 50 * 60000).toISOString(), posti_richiesti: 3, prezzo: 90, classe: 'STANDARD' },
  { id: 103, start_node_id: 8, end_node_id: 7, start_datetime: new Date(t0 + 100 * 60000).toISOString(), posti_richiesti: 2, prezzo: 90, classe: 'STANDARD' }
];
const corridorData = [
  { id: 'm1', nodes: [7, 5], richiestaIds: [101], verificataRouting: true, legs: [leg()] },
  { id: 'm2', nodes: [5, 8], richiestaIds: [102], verificataRouting: true, legs: [leg()] },
  { id: 'm3', nodes: [8, 7], richiestaIds: [103], verificataRouting: true, legs: [leg()] }
];
const corridorMap = new Map(corridorData.map(c => [c.id, c]));
const requestMap = new Map(requests.map(r => [r.id, r]));
const engine = {
  getCorridor: id => corridorMap.get(id),
  getRequest: id => requestMap.get(Number(id))
};
const vehicle = { id: 353, driver_id: 2, posti_totali: 4, euro_km: 0.5, lat: 40.3515, lon: 18.1750 };

// Estrae la funzione originale dal worker con bilanciamento lessicale delle parentesi.
// Il worker NON viene importato né eseguito come modulo: niente effetti collaterali.
function extractFunction(source, name) {
  const signature = `async function ${name}(`;
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`Funzione ${name} non trovata nel worker`);
  const brace = source.indexOf('{', start + signature.length);
  // La prima { potrebbe appartenere alla destructuring dei parametri: trova la chiusura ') {'
  const bodyMatch = /\)\s*\{/.exec(source.slice(start));
  if (!bodyMatch) throw new Error('Firma della funzione non riconosciuta');
  const bodyStart = start + bodyMatch.index + bodyMatch[0].lastIndexOf('{');
  let depth = 0, quote = null, escape = false, lineComment = false, blockComment = false;
  for (let i = bodyStart; i < source.length; i++) {
    const c = source[i], n = source[i + 1];
    if (lineComment) { if (c === '\n') lineComment = false; continue; }
    if (blockComment) { if (c === '*' && n === '/') { blockComment = false; i++; } continue; }
    if (quote) { if (escape) { escape = false; continue; } if (c === '\\') { escape = true; continue; } if (c === quote) quote = null; continue; }
    if (c === '/' && n === '/') { lineComment = true; i++; continue; }
    if (c === '/' && n === '*') { blockComment = true; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    if (c === '}') { depth--; if (depth === 0) return source.slice(start, i + 1); }
  }
  throw new Error('Funzione worker non terminata');
}

console.log('=== TURENTU POPBUS / TEST 20 E2E CONTROLLATO SHADOW ===');
console.log('MODALITA: WORKER ISOLATO + ADAPTER + ASSEMBLER + OTTIMIZZATORE REALI; SQL MOCK; ZERO DB/STRIPE');
for (const [name, filename] of Object.entries(paths)) check(fs.existsSync(filename), `File presente: ${name}`);
if (fail) process.exitCode = 1;
else {
  try {
    const workerSource = fs.readFileSync(paths.worker, 'utf8');
    const fn = extractFunction(workerSource, 'eseguiCicliPixelShadow');
    check(fn.includes('componiCicloInCorsa('), 'Worker chiama assembler nella funzione reale');
    check(/postiTotali\s*:\s*vehicle\.posti_totali/.test(fn), 'Worker trasmette postiTotali del veicolo');
    check(!/\b(?:INSERT|UPDATE|DELETE|COMMIT|BEGIN)\b/i.test(fn.replace(/\/\/[^\n]*/g, '')), 'Funzione PIXEL isolata senza SQL di scrittura');

    const { diagnosticaCicloPixelPopbus } = await import(pathToFileURL(paths.adapter).href);
    const { componiCicloInCorsa } = await import(pathToFileURL(paths.assembler).href);
    const { ottimizzaFlotta } = await import(pathToFileURL(paths.optimizer).href);
    const { registraMissioniAttivazione } = await import(pathToFileURL(paths.persistence).href);
    const seen = { calls: [], assembled: [], optimized: [], selected: [], conflicts: 0, logs: [], optimization: null };
    const road = async (a, b) => {
      if (Math.abs(Number(a.lat) - Number(b.lat)) < 1e-7 && Math.abs(Number(a.lon) - Number(b.lon)) < 1e-7)
        return { metres: 0, seconds: 0, roadCoincident: true };
      return leg(1000, 60);
    };
    const instrumentedAdapter = async args => {
      seen.calls.push(args);
      return diagnosticaCicloPixelPopbus({ ...args, now: t0 - 86400000 });
    };
    const instrumentedAssembler = args => {
      const result = componiCicloInCorsa(args);
      seen.assembled.push({ args, result });
      return result;
    };
    const context = vm.createContext({
      POPBUS_PIXEL_MAX_MISSIONI: 24,
      POPBUS_PIXEL_MAX_VEICOLI: 20,
      POPBUS_MAX_MISSIONI_PER_CICLO: 3,
      POPBUS_PIXEL_MAX_CICLI: 180,
      diagnosticaCicloPixelPopbus: instrumentedAdapter,
      componiCicloInCorsa: instrumentedAssembler,
      ottimizzaFlotta: candidates => {
        seen.optimized.push(...candidates);
        const result = ottimizzaFlotta(candidates, {maxNodi: 100000, maxCandidati: 5000});
        seen.optimization = result;
        seen.selected.push(...result.selezionati);
        return result;
      },
      movement: road,
      turno: () => true,
      conflittiVeicolo: async () => { seen.conflicts++; return []; },
      Date: class extends Date { static now() { return t0 - 86400000; } },
      Set, Map, Number, Math, Array, JSON, Error
    });
    vm.runInContext(`${fn}\nthis.execute = eseguiCicliPixelShadow;`, context, { timeout: 3000 });
    const stats = {};
    await context.execute({ engine, corridors: corridorData, requests, nodes, vehicles: [vehicle],
      client: { query: () => { throw Error('ACCESSO DB VIETATO'); } },
      log: (name, payload) => seen.logs.push({ name, payload }), stats });
    check(seen.calls.length > 0, 'Worker esegue adapter reale');
    check(seen.assembled.length > 0, 'Worker raggiunge assembler reale');
    const three = seen.assembled.find(x => x.args.missioni.length === 3);
    check(Boolean(three), 'Worker costruisce un ciclo a tre missioni',
      `cicli assemblati=${seen.assembled.length}; motivi=${JSON.stringify(seen.logs.find(x => x.name.includes('OTTIMIZZAZIONE'))?.payload?.motivi || {})}`);
    if (three) {
      const { args, result } = three;
      check(Number(args.postiTotali) === 4, 'Capienza veicolo trasmessa: 4');
      check(args.missioni.flatMap(m => m.requests).map(r => Number(r.posti_richiesti)).join(',') === '2,3,2', 'Posti richiesti conservati: 2,3,2');
      check(result.validazioneCapienza?.verificata === true, 'Capienza globale verificata');
      check(result.evaluation?.peak === 3, 'Picco globale = 3');
      check(result.validazioneCapienza?.totalePasseggeri === 7, 'Passeggeri trasportati = 7');
      check(result.evaluation?.requests?.map(r => `${r.id}:${r.start}-${r.end}`).join(',') === '101:0-1,102:3-4,103:6-7', 'Indici globali corretti');
      check(args.trasferimenti.length === 2 && args.trasferimenti.every(t => t.leg), 'Trasferimenti conservati');
      check(result.attivabile === false, 'Ciclo rimane NON attivabile');
      check(seen.optimized.some(c => c._corsaGlobale === result), 'Ottimizzatore reale riceve il ciclo globale del worker');
    }
    check(Boolean(seen.optimization), 'Ottimizzatore reale eseguito');
    check(seen.selected.length > 0, 'Ottimizzatore reale seleziona almeno un ciclo');
    const chosenIds = seen.selected.flatMap(c => (c.richieste ?? c.evaluation?.requests ?? []).flat(Infinity).map(r => Number(r?.id ?? r)));
    check(new Set(chosenIds).size === chosenIds.length, 'Nessuna richiesta duplicata tra cicli selezionati');
    const vehicleWindows = seen.selected.map(c => ({id: Number(c.veicolo ?? c.vehicle?.id), start: Date.parse(c.partenza_base ?? c.busyStart), end: Date.parse(c.ritorno_base ?? c.busyEnd)}));
    check(vehicleWindows.every((a,i) => vehicleWindows.every((b,j) => i === j || a.id !== b.id || a.end <= b.start || b.end <= a.start)), 'Nessun conflitto veicolo tra cicli selezionati');
    check(seen.optimization.ottimoDimostrato === true || seen.optimization.limiteNodiRaggiunto === true || seen.optimization.candidatiTagliati > 0, 'Certificazione ottimalita coerente con limiti');

    // Persistenza relazionale reale, con client SQL fittizio: nessuna connessione al DB.
    // Si registra il ciclo a tre missioni generato dal worker, anche se non selezionato:
    // e' un DRY RUN del contratto, non una simulazione di acceptance riuscita.
    const writes = [];
    let missionSequence = 9000;
    const mockClient = { async query(sql, params) {
      if (!/^\s*INSERT INTO public\.(popbus_attivazione_missioni|popbus_missione_richieste)\b/i.test(sql)) {
        throw new Error('SQL inatteso nel mock: ' + sql.slice(0, 90));
      }
      const table = /INSERT INTO public\.(\w+)/i.exec(sql)[1];
      writes.push({table, params});
      return {rows: table === 'popbus_attivazione_missioni' ? [{id: ++missionSequence}] : []};
    }};
    if (three) {
      const missions = three.args.missioni.map(m => ({
        nodes: m.nodes, legs: m.legs, requests: m.requests,
        departure: m.departure, arrival: m.arrival,
        direttriceId: m.direttriceId ?? null, corridoioPixelId: m.corridoioPixelId ?? null
      }));
      const ids = await registraMissioniAttivazione(mockClient, {attivazioneId: 501, missioni: missions});
      check(ids.length === 3, 'Persistenza reale invocata su tre missioni con SQL mock');
      check(writes.filter(x => x.table === 'popbus_attivazione_missioni').length === 3, 'Tre INSERT missione nel mock');
      check(writes.filter(x => x.table === 'popbus_missione_richieste').length === 3, 'Tre associazioni richiesta-missione nel mock');
      check(writes.filter(x => x.table === 'popbus_missione_richieste').every(x => x.params[2] === 0 && x.params[3] === 1), 'Indici locali persistiti 0->1');
      check(three.result.evaluation.requests.map(r => `${r.id}:${r.start}-${r.end}`).join(',') === '101:0-1,102:3-4,103:6-7', 'Mapping globale pronto per attivazione (non scritto)');
    }
    const acceptanceSource = fs.readFileSync(paths.acceptance, 'utf8');
    check(/Accettazione ciclo multi-missione non ancora abilitata/.test(acceptanceSource), 'Guardia multi-missione reale ancora attiva');
    check(three?.result.attivabile === false, 'Ciclo a tre missioni NON attivabile');
    check(!writes.some(w => ['corse','prenotazioni','pagamenti'].includes(w.table)), 'Nessuna corsa o pagamento simulati come reali');
    console.log('GAP Acceptance reale multi-missione NON eseguita: guardia attiva.');
    console.log('GAP PostgreSQL, Stripe, Google Routing, socket e cron NON eseguiti.');
    console.log('GAP La funzione worker e isolata: i conflitti e i turni usano stub controllati.');
    console.log('GAP Il mapping globale e verificato in memoria, non scritto in PostgreSQL.');
    check(seen.conflicts > 0, 'Worker verifica conflitti per veicolo (mock senza DB)');
    check(stats.pixelCicliValidi > 0, 'Worker contabilizza cicli diagnostici validi');
    check(seen.logs.some(x => x.name === 'PIXEL CICLI OTTIMIZZAZIONE SHADOW'), 'Worker emette riepilogo shadow');
    console.log('RIEPILOGO', JSON.stringify({
      candidateOttimizzatore: seen.optimized.length, cicliOttimizzati: seen.selected.length,
      nodiEsplorati: seen.optimization?.nodiEsplorati, ottimoDimostrato: seen.optimization?.ottimoDimostrato,
      insertMissioniMock: writes.filter(w => w.table === 'popbus_attivazione_missioni').length,
      chiamateAdapter: seen.calls.length, cicliAssemblati: seen.assembled.length,
      cicliValidi: stats.pixelCicliValidi, cicliSelezionati: stats.pixelCicliSelezionati,
      treMissioni: Boolean(three), peak: three?.result.evaluation?.peak,
      totalePasseggeri: three?.result.validazioneCapienza?.totalePasseggeri,
      attivabile: three?.result.attivabile, modalita: 'SOLA LETTURA, FUNZIONE WORKER ISOLATA'
    }, null, 2));
  } catch (err) {
    check(false, 'Esecuzione Test 20', err.stack || err.message);
  }
}
console.log(`ESITO: ${pass} PASS, ${fail} FAIL, 4 GAP dichiarati. Nessuna scrittura reale.`);
if (fail) process.exitCode = 1;
