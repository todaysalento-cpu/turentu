// POPBUS V2 - Diagnostica aggregazione reale 39 + 40 - SOLA LETTURA.
// Dalla root: node --env-file=.env tests/test_popbus_aggregazione_39_40_readonly.mjs --live
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const LIVE = process.argv.includes('--live');
const IDS = [39, 40];
const log = (event, data = {}) => console.log(JSON.stringify({ event, ...data }));
const moduleAt = p => import(pathToFileURL(resolve(process.cwd(), p)).href);
const requestIds = e => e?.requests?.map(x => Number(x.id)).sort((a,b)=>a-b) ?? [];
const hasBoth = e => IDS.every(id => requestIds(e).includes(id));
const valid = r => Number.isSafeInteger(Number(r.id)) && Number.isSafeInteger(Number(r.start_node_id)) &&
  Number.isSafeInteger(Number(r.end_node_id)) && Number(r.start_node_id) !== Number(r.end_node_id) &&
  Number.isFinite(new Date(r.start_datetime).getTime()) && Number.isInteger(Number(r.posti_richiesti)) &&
  Number(r.posti_richiesti) > 0 && r.prezzo != null && Number.isFinite(Number(r.prezzo)) && Number(r.prezzo) >= 0;
function windowCheck(plan, rs) {
  const index = new Map(plan.nodes.map((id, i) => [Number(id), i]));
  let lower = -Infinity, upper = Infinity;
  const offsets = [0];
  for (const leg of plan.legs) offsets.push(offsets.at(-1) + Number(leg.seconds) * 1000);
  const detail = [];
  for (const r of rs) {
    const s = index.get(Number(r.start_node_id));
    const e = index.get(Number(r.end_node_id));
    if (s == null || e == null || s >= e) return { compatible: false, reason: 'TRATTA_NON_PRESENTE' };
    const base = new Date(r.start_datetime).getTime() - offsets[s];
    const a = base - 30*60000, b = base + 30*60000;
    lower = Math.max(lower, a); upper = Math.min(upper, b);
    detail.push({ id: Number(r.id), pickupOffsetSeconds: offsets[s]/1000,
      requested: new Date(r.start_datetime).toISOString(), windowStart: new Date(a).toISOString(), windowEnd: new Date(b).toISOString() });
  }
  return { compatible: lower <= upper, overlapMinutes: Number(((upper-lower)/60000).toFixed(3)),
    departureWindow: lower <= upper ? [new Date(lower).toISOString(), new Date(upper).toISOString()] : null, detail };
}

console.log('TURENTU POPBUS V2 - AGGREGAZIONE RICHIESTE 39 + 40 - SOLA LETTURA');
if (!LIVE) {
  console.log('PREVIEW: nessuna connessione DB e nessuna chiamata Google Maps.');
  console.log('Eseguire: node --env-file=.env tests\\test_popbus_aggregazione_39_40_readonly.mjs --live');
  process.exit(0);
}
let pool, client;
const stats = { richiesteTrovate:0, candidate:0, pianiValidi:0, erroriRouting:0, gruppiObbligatoriAccettati:0, gruppiGreedyProdotti:0 };
try {
  ({pool} = await moduleAt('db/db.js'));
  const {generaCandidate, valutaRichieste, verificaQualitaRichieste} = await moduleAt('services/popbus/v2/model.js');
  const {pianifica} = await moduleAt('services/popbus/v2/planner.js');
  client = await pool.connect();
  await client.query('BEGIN TRANSACTION READ ONLY');
  await client.query('SET LOCAL statement_timeout = 10000');
  const {rows} = await client.query(`
    SELECT r.* FROM richieste_pop_bus r WHERE r.id = ANY($1::int[]) ORDER BY r.id
  `, [IDS]);
  stats.richiesteTrovate = rows.length;
  for (const r of rows) log('RICHIESTA', { id:Number(r.id), stato:r.stato, corsa_id:r.corsa_id,
    origine:Number(r.start_node_id), destinazione:Number(r.end_node_id),
    partenza:new Date(r.start_datetime).toISOString(), posti:Number(r.posti_richiesti), prezzo:Number(r.prezzo),
    datiValidi:valid(r) });
  if (rows.length !== 2 || rows.some(r=>!valid(r))) {
    log('STOP', {motivo:'Richieste mancanti o dati non validi'});
  } else {
    const active = rows.every(r=>r.stato==='in_attesa' && r.corsa_id==null && new Date(r.start_datetime).getTime()>Date.now());
    const {rows: reserved} = await client.query(`SELECT richiesta_id FROM popbus_attivazione_richieste WHERE richiesta_id=ANY($1::int[]) AND attiva`, [IDS]);
    log('STATO_WORKER', { richiesteAttiveFuture:active, prenotazioniAttive:reserved.map(r=>Number(r.richiesta_id)),
      nota:'Diagnostica eseguita anche se richieste non eleggibili al worker; non equivale ad attivabilita' });
    const nodeIds = [...new Set(rows.flatMap(r=>[Number(r.start_node_id),Number(r.end_node_id)]))];
    const {rows:nodes} = await client.query(`SELECT id, nome_nodo, ST_Y(posizione::geometry) AS lat, ST_X(posizione::geometry) AS lon FROM nodi_direttrice WHERE id=ANY($1::int[])`, [nodeIds]);
    if (nodes.length !== nodeIds.length) throw new Error('Nodi non trovati nel catalogo');
    const candidates = generaCandidate(rows, 100);
    stats.candidate = candidates.length;
    log('GENERATORE_V2', { candidate:candidates.map(c=>({nodes:c.nodes,seeds:c.seeds,classe:c.classe})),
      generaSeedCombinato:candidates.some(c=>IDS.every(id=>c.seeds.includes(id))) });
    const checked = new Set();
    for (const c of candidates) {
      const pathKey = c.nodes.join(':');
      if (checked.has(pathKey)) continue;
      checked.add(pathKey);
      try {
        const plan = await pianifica(c, nodes);
        stats.pianiValidi++;
        const window = windowCheck(plan, rows);
        const single39 = valutaRichieste(plan, rows, [39], {mode:'seeds_only'});
        const single40 = valutaRichieste(plan, rows, [40], {mode:'seeds_only'});
        const both = valutaRichieste(plan, rows, [39,40], {mode:'seeds_only'});
        const greedy39 = valutaRichieste(plan, rows, [39], {mode:'greedy'});
        const greedy40 = valutaRichieste(plan, rows, [40], {mode:'greedy'});
        const quality = verificaQualitaRichieste(plan, rows);
        if (both) stats.gruppiObbligatoriAccettati++;
        if (hasBoth(greedy39) || hasBoth(greedy40)) stats.gruppiGreedyProdotti++;
        log('CONFRONTO', {percorso:plan.nodes, durataSecondi:plan.legs.reduce((s,l)=>s+Number(l.seconds),0),
          finestre:window, qualitaGruppo:quality,
          singola39:{accettata:!!single39, peak:single39?.peak??null},
          singola40:{accettata:!!single40, peak:single40?.peak??null},
          gruppoObbligatorio:{accettato:!!both, richieste:requestIds(both), peak:both?.peak??null,
            departure:both?new Date(both.departure).toISOString():null},
          greedy39:{richieste:requestIds(greedy39), peak:greedy39?.peak??null},
          greedy40:{richieste:requestIds(greedy40), peak:greedy40?.peak??null},
          nota:'La capienza reale del veicolo non e applicata: maxPeak non impostato; test solo di aggregazione geometrica/temporale/qualita' });
      } catch (err) {stats.erroriRouting++; log('ERRORE_PIANO',{seeds:c.seeds,errore:err.message});}
    }
  }
} catch(err) {log('ERRORE',{messaggio:err.message});process.exitCode=1;}
finally {
  if(client){try{await client.query('ROLLBACK');}catch(e){log('ROLLBACK_ERROR',{messaggio:e.message});}client.release();}
  if(pool)await pool.end();
  log('RIEPILOGO',{...stats, conclusivo:stats.pianiValidi>0});
}
