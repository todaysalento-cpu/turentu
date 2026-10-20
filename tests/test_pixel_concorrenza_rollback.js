// TURENTU PIXEL — due transazioni concorrenti sulla stessa direttrice.
// Nessun COMMIT. Non modifica servizi o worker. Entrambe le transazioni terminano con ROLLBACK.
import { readFile } from 'node:fs/promises';
import { pool } from '../db/db.js';
import { leg } from '../services/popbus/v2/planner.js';
import { createIncrementalCorridorEngine } from '../services/pixel/incremental-corridor-engine.js';
import { pubblicaOpportunitaPixel, leggiOpportunitaPixel } from '../services/pixel/pixel.persistence.service.js';

const assert = (v, m) => { if (!v) throw new Error(`PIXEL CONCORRENZA: ${m}`); };
const ids = [8, 5];
const engineId = 'territorial:8>5';
let a, b;
let failed = false;
const started = new Set();
const begin = async (client, name) => {
  await client.query('BEGIN');
  started.add(name);
  await client.query("SET LOCAL statement_timeout = '30s'");
  await client.query("SET LOCAL lock_timeout = '2500ms'");
};
const rollback = async (client, name) => {
  if (!client || !started.has(name)) return;
  try { await client.query('ROLLBACK'); console.log(`ROLLBACK ${name}: OK`); }
  finally { started.delete(name); }
};
try {
  const source = await readFile(new URL('../services/pixel/pixel.persistence.service.js', import.meta.url), 'utf8');
  assert(/client\s*:\s*externalClient/.test(source) && /externalClient\s*\?\?\s*await\s+pool\.connect/.test(source),
    'il publisher non supporta il client transazionale esterno');
  assert(/pg_advisory_xact_lock/.test(source) && /hashtextextended/.test(source),
    'publisher privo di lock transazionale advisory per direttrice');
  assert(/client\s*=\s*null/.test(source), 'reader POPBUS privo di client esterno');

  a = await pool.connect();
  b = await pool.connect();
  assert(a !== b, 'sono necessarie due connessioni distinte');
  await begin(a, 'A');
  await begin(b, 'B');
  const preexisting = await a.query(
    'SELECT id FROM public.pixel_direttrici WHERE engine_id=$1 LIMIT 1', [engineId]);
  assert(preexisting.rowCount === 0,
    `esiste gia ${engineId} nel DB: interrompo per non interferire con dati reali`);

  const { rows } = await a.query(`SELECT id, nome, ST_Y(posizione::geometry) AS lat,
    ST_X(posizione::geometry) AS lon FROM public.nodi_territoriali
    WHERE id=ANY($1::bigint[]) AND attivo=TRUE`, [ids]);
  assert(rows.length === 2, 'nodi 8 e 5 assenti o inattivi');
  const nodeMap = new Map(rows.map(r => [Number(r.id), { ...r, lat: Number(r.lat), lon: Number(r.lon) }]));
  const routeNodes = async sequence => {
    const legs = [];
    for (let i = 1; i < sequence.length; i++) {
      const r = await leg(nodeMap.get(Number(sequence[i - 1])), nodeMap.get(Number(sequence[i])));
      assert(r && r.metres > 0 && r.seconds > 0 && typeof r.polyline === 'string' && r.polyline.length,
        'routing stradale non valido');
      legs.push({ metres: r.metres, seconds: r.seconds, polyline: r.polyline, roadCoincident: false });
    }
    return { verificataRouting: true, legs };
  };
  const start = new Date(Date.now() + 14 * 86400000);
  start.setUTCHours(9, 0, 0, 0);
  const insertRequest = async client => {
    const from = nodeMap.get(8), to = nodeMap.get(5);
    const { rows: inserted } = await client.query(`
      INSERT INTO public.richieste_pop_bus
        (origine,destinazione,origine_nodo_territoriale_id,destinazione_nodo_territoriale_id,
         origine_address,destinazione_address,start_datetime,posti_richiesti,stato,classe,prezzo)
      VALUES (ST_SetSRID(ST_MakePoint($1,$2),4326), ST_SetSRID(ST_MakePoint($3,$4),4326),
              8,5,$5,$6,$7,1,'in_attesa','STANDARD',7)
      RETURNING *`, [from.lon, from.lat, to.lon, to.lat, from.nome, to.nome, start]);
    return inserted[0];
  };
  const ra = await insertRequest(a);
  const rb = await insertRequest(b);
  const makeEngine = async request => {
    const e = createIncrementalCorridorEngine({ routeNodes, abilitaVariantiP1: false });
    await e.processRequest(request);
    const corridor = e.listCorridors().find(c => c.nodes.join('>') === '8>5');
    assert(corridor && corridor.richiestaIds.includes(Number(request.id)), 'direttrice non generata');
    return { engine: e, direttriceId: corridor.id };
  };
  const ea = await makeEngine(ra);
  const eb = await makeEngine(rb);
  console.log('DUE TRANSAZIONI PRONTE:', { richiestaA: ra.id, richiestaB: rb.id, direttrice: engineId });

  const publishedA = await pubblicaOpportunitaPixel({ ...ea, bufferMinuti: 0, client: a });
  assert(Number(publishedA.opportunitaCandidate) > 0, 'A non ha pubblicato opportunita');
  console.log('A PUBBLICA E MANTIENE IL LOCK:', publishedA);

  // SAVEPOINT: un timeout su B non deve invalidare tutta la transazione di test.
  await b.query('SAVEPOINT before_conflict');
  let conflict;
  try {
    await pubblicaOpportunitaPixel({ ...eb, bufferMinuti: 0, client: b });
  } catch (error) {
    conflict = error;
  }
  assert(conflict, 'B ha pubblicato mentre A manteneva il lock: serializzazione NON dimostrata');
  assert(conflict.code === '55P03',
    `conflitto inatteso: SQLSTATE=${conflict.code ?? 'assente'}, ${conflict.message}`);
  console.log('B BLOCCATO CORRETTAMENTE:', { sqlstate: conflict.code, message: conflict.message });
  await b.query('ROLLBACK TO SAVEPOINT before_conflict');
  await b.query('RELEASE SAVEPOINT before_conflict');

  // Verifica che B non veda le scritture non confermate di A.
  const invisible = await b.query('SELECT count(*)::int AS n FROM public.pixel_direttrici WHERE engine_id=$1', [engineId]);
  assert(invisible.rows[0].n === 0, 'B vede dati non confermati di A');
  console.log('ISOLAMENTO SQL OK: B non vede le scritture non confermate di A');

  await rollback(a, 'A');
  const publishedB = await pubblicaOpportunitaPixel({ ...eb, bufferMinuti: 0, client: b });
  assert(Number(publishedB.opportunitaCandidate) > 0, 'B non riesce a pubblicare dopo il rilascio del lock');
  const visibleB = await leggiOpportunitaPixel({ limit: 1000, client: b });
  assert(visibleB.some(o => o.nodi.map(Number).join('>') === '8>5' &&
    o.richiesta_ids.map(Number).includes(Number(rb.id))), 'POPBUS non vede la pubblicazione B');
  assert(!visibleB.some(o => o.richiesta_ids.map(Number).includes(Number(ra.id))),
    'POPBUS vede la richiesta A dopo rollback A');
  console.log('TEST CONCORRENZA OK:', {
    bloccoEsclusivo: true, isolamento: true, retryDopoRollback: true,
    visibilePopbus: true, richiestaB: rb.id, opportunitaB: publishedB.opportunitaCandidate
  });
} catch (error) {
  failed = true;
  console.error('TEST CONCORRENZA FALLITO:', { code: error.code, message: error.message, stack: error.stack });
} finally {
  for (const [client, name] of [[b, 'B'], [a, 'A']]) {
    try { await rollback(client, name); }
    catch (error) { failed = true; console.error(`ROLLBACK ${name} FALLITO:`, error.message); }
    finally { if (client) client.release(); }
  }
  await pool.end();
  console.log('FINE TEST: nessuna transazione confermata.');
}
if (failed) process.exitCode = 1;
