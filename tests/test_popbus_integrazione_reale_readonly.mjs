// POPBUS V2 — diagnostica reale, sola lettura.
// Eseguire dalla root: node tests/test_popbus_integrazione_reale_readonly.mjs --live
// Senza --live non apre DB e non chiama routing.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
const live = args.includes('--live');
const argValue = (name, fallback) => {
  const arg = args.find(x => x.startsWith(name + '='));
  return arg ? arg.slice(name.length + 1) : fallback;
};
const bounded = (name, def, max) => {
  const n = Number(argValue(name, def));
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw Error(`${name} deve essere 1..${max}`);
  return n;
};
const maxRequests = bounded('--requests', 12, 50);
const maxCandidates = bounded('--candidates', 100, 500);
const maxRoutes = bounded('--routes', 15, 100);
const timeoutMs = bounded('--timeout-ms', 120000, 600000);
const root = process.cwd();
const moduleAt = async p => import(pathToFileURL(resolve(root, p)).href);
const log = (event, value) => console.log(JSON.stringify({ event, ...value }));
const validRequest = r => Number.isSafeInteger(Number(r.id)) && Number(r.id) > 0 &&
  Number.isSafeInteger(Number(r.start_node_id)) && Number.isSafeInteger(Number(r.end_node_id)) &&
  Number(r.start_node_id) !== Number(r.end_node_id) &&
  Number.isFinite(new Date(r.start_datetime).getTime()) &&
  Number.isInteger(Number(r.posti_richiesti)) && Number(r.posti_richiesti) > 0 &&
  r.prezzo != null && Number.isFinite(Number(r.prezzo)) && Number(r.prezzo) >= 0;

function temporalCheck(plan, selected) {
  const idx = new Map(plan.nodes.map((id, i) => [Number(id), i]));
  if (idx.size !== plan.nodes.length) return { ok: false, reason: 'NODI_DUPLICATI' };
  const offsets = [0];
  for (const leg of plan.legs) offsets.push(offsets.at(-1) + Number(leg.seconds) * 1000);
  let lo = -Infinity, hi = Infinity;
  for (const r of selected) {
    const s = idx.get(Number(r.start_node_id)), e = idx.get(Number(r.end_node_id));
    if (s == null || e == null || s >= e) return { ok: false, reason: 'TRATTA_NON_PRESENTE' };
    const t = new Date(r.start_datetime).getTime() - offsets[s];
    lo = Math.max(lo, t - 1800000);
    hi = Math.min(hi, t + 1800000);
  }
  return { ok: lo <= hi, reason: lo <= hi ? 'COMPATIBILE' : 'TEMPO_INCOMPATIBILE', margine_min: Math.round((hi - lo) / 60000 * 1000) / 1000 };
}

console.log('TURENTU POPBUS — COLLAUDO ROUTING/VALUTAZIONE V2 — SOLA LETTURA');
if (!live) {
  console.log('MODALITA PREVIEW: nessuna connessione al DB e nessuna chiamata routing.');
  console.log('Per eseguire: node tests/test_popbus_integrazione_reale_readonly.mjs --live');
  console.log('Opzioni: --requests=12 --candidates=100 --routes=15 --timeout-ms=120000');
  console.log('ATTENZIONE: --live legge richieste reali e invoca il provider routing; possibili costi API.');
  process.exit(0);
}

let pool, client;
const stats = { richiesteLette: 0, richiesteUsabili: 0, nodi: 0, candidateGenerate: 0, candidateEsaminate: 0, pianiValidi: 0, erroriRouting: 0, valutazioniV2Accettate: 0, valutazioniV2Respinte: 0, falsiNegativiTemporali: 0, falsiPositiviTemporali: 0, nonValutate: 0 };
const started = Date.now();
try {
  ({ pool } = await moduleAt('db/db.js'));
  const { generaCandidate, valutaRichieste } = await moduleAt('services/popbus/v2/model.js');
  const { pianifica } = await moduleAt('services/popbus/v2/planner.js');
  client = await pool.connect();
  // Una transazione READ ONLY impedisce scritture accidentali in questa connessione.
  await client.query('BEGIN TRANSACTION READ ONLY');
  await client.query('SET LOCAL statement_timeout = 10000');
  const { rows: requestsRaw } = await client.query(`
    SELECT r.* FROM richieste_pop_bus r
    WHERE r.stato='in_attesa' AND r.start_datetime>NOW() AND r.corsa_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM popbus_attivazione_richieste ar
                      WHERE ar.richiesta_id=r.id AND ar.attiva)
    ORDER BY r.start_datetime,r.id LIMIT $1::int
  `, [maxRequests]);
  stats.richiesteLette = requestsRaw.length;
  const requests = requestsRaw.filter(validRequest);
  stats.richiesteUsabili = requests.length;
  if (requests.length !== requestsRaw.length) log('AVVISO', { messaggio: 'Alcune richieste non hanno campi validi per il modello V2', scartate: requestsRaw.length - requests.length });
  log('AVVISO', { messaggio: 'La verifica pagamenti del worker NON viene eseguita: test diagnostico, non certificazione di attivabilita' });
  if (!requests.length) { log('STOP', { motivo: 'Nessuna richiesta utilizzabile' }); process.exitCode = 0; }
  else {
    const ids = [...new Set(requests.flatMap(r => [Number(r.start_node_id), Number(r.end_node_id)]))];
    const { rows: nodes } = await client.query(`
      SELECT id, nome_nodo, ST_Y(posizione::geometry) AS lat, ST_X(posizione::geometry) AS lon
      FROM nodi_direttrice WHERE id=ANY($1::int[])
    `, [ids]);
    stats.nodi = nodes.length;
    const validNodes = nodes.filter(n => Number.isFinite(Number(n.lat)) && Number.isFinite(Number(n.lon)));
    const nodeSet = new Set(validNodes.map(n => Number(n.id)));
    const usable = requests.filter(r => nodeSet.has(Number(r.start_node_id)) && nodeSet.has(Number(r.end_node_id)));
    if (usable.length !== requests.length) log('AVVISO', { messaggio: 'Richieste con nodi mancanti', scartate: requests.length - usable.length });
    let candidates;
    try { candidates = generaCandidate(usable, maxCandidates); }
    catch (e) { log('GENERATORE_LIMITATO', { errore: e.message, suggerimento: 'Ridurre --requests; NON aumentare indiscriminatamente il limite' }); candidates = []; }
    stats.candidateGenerate = candidates.length;
    for (const c of candidates.slice(0, maxRoutes)) {
      if (Date.now() - started > timeoutMs) { log('STOP_TEMPO', { timeoutMs }); break; }
      stats.candidateEsaminate++;
      try {
        const plan = await pianifica(c, validNodes);
        stats.pianiValidi++;
        const selected = usable.filter(r => c.seeds.map(Number).includes(Number(r.id)));
        const temporal = temporalCheck(plan, selected);
        // seeds_only evita che l'aggiunta greedy nasconda l'esito dei seed.
        const evaluated = valutaRichieste(plan, usable, c.seeds, { mode: 'seeds_only' });
        const accepted = evaluated !== null;
        if (accepted) stats.valutazioniV2Accettate++; else stats.valutazioniV2Respinte++;
        if (accepted && !temporal.ok) stats.falsiNegativiTemporali++;
        if (!accepted && temporal.ok) stats.falsiPositiviTemporali++;
        log('CANDIDATA', { seeds: c.seeds, mandatory: c.nodes, nodes: plan.nodes,
          seconds: plan.cumulativeSeconds, temporal, v2Accepted: accepted,
          v2Peak: evaluated?.peak ?? null,
          nota: !accepted && temporal.ok ? 'V2 puo rifiutare per qualita, capienza o altri vincoli' : undefined });
      } catch (e) { stats.erroriRouting++; log('ERRORE_PIANO', { seeds: c.seeds, nodes: c.nodes, errore: e.message }); }
    }
  }
} catch (e) {
  log('ERRORE', { messaggio: e.message, stack: e.stack });
  process.exitCode = 1;
} finally {
  if (client) {
    try { await client.query('ROLLBACK'); } catch (e) { log('ROLLBACK_ERROR', { messaggio: e.message }); }
    client.release();
  }
  if (pool) await pool.end();
  log('RIEPILOGO', { ...stats, ms: Date.now() - started,
    avvertenza: 'NON confronta ancora il generatore a pixel: serve il suo modulo reale. Falsi negativi = solo controllo temporale su piani V2.' });
}
