// TURENTU PIXEL - bootstrap persistente di sola lettura.
// La diagnostica conserva il contratto originale; il bootstrap espone anche l'engine
// ai servizi operativi. Nessuna scrittura DB in questo modulo.
import { pool } from '../../db/db.js';
import { leg } from '../popbus/v2/planner.js';
import { createIncrementalCorridorEngine } from './incremental-corridor-engine.js';

const check = (ok, msg) => { if (!ok) throw new Error(`PIXEL_BOOTSTRAP: ${msg}`); };
const nodeId = x => {
  const n = Number(x);
  check(Number.isSafeInteger(n) && n > 0, `ID nodo non valido: ${x}`);
  return n;
};

export async function costruisciBootstrapPixel({
  client = null,
  now = new Date(),
  maxRichieste = 100,
  maxDirettrici = 500,
  abilitaVariantiP1 = true,
  bufferMinuti = 0
} = {}) {
  check(Number.isSafeInteger(maxRichieste) && maxRichieste >= 1 && maxRichieste <= 10000, 'maxRichieste non valido');
  check(Number.isSafeInteger(maxDirettrici) && maxDirettrici >= 1 && maxDirettrici <= 10000, 'maxDirettrici non valido');
  check(now instanceof Date && Number.isFinite(now.getTime()), 'now non valido');
  check(Number.isFinite(bufferMinuti) && bufferMinuti >= 0, 'bufferMinuti non valido');
  const db = client ?? pool;

  const requestResult = await db.query(`
    SELECT * FROM public.richieste_pop_bus
    WHERE stato = 'in_attesa'
      AND start_datetime >= $1
      AND origine_nodo_territoriale_id IS NOT NULL
      AND destinazione_nodo_territoriale_id IS NOT NULL
      AND origine_nodo_territoriale_id <> destinazione_nodo_territoriale_id
      AND posti_richiesti > 0
    ORDER BY created_at NULLS LAST, id
    LIMIT $2`, [now, maxRichieste + 1]);
  check(requestResult.rows.length <= maxRichieste, 'troppe richieste: aumentare limite senza troncamento');

  const corridorResult = await db.query(`
    SELECT id, engine_id, versione, nodi, legs
    FROM public.pixel_direttrici
    WHERE stato = 'attiva'
    ORDER BY engine_id, versione DESC, id DESC
    LIMIT $1`, [maxDirettrici + 1]);
  check(corridorResult.rows.length <= maxDirettrici, 'troppe direttrici: aumentare limite senza troncamento');
  const latest = new Map();
  for (const c of corridorResult.rows) {
    check(!latest.has(c.engine_id), `piu versioni attive per ${c.engine_id}: correggere catalogo prima di procedere`);
    latest.set(c.engine_id, c);
  }

  const requests = requestResult.rows.map(r => ({
    ...r,
    id: Number(r.id),
    origine_nodo_territoriale_id: nodeId(r.origine_nodo_territoriale_id),
    destinazione_nodo_territoriale_id: nodeId(r.destinazione_nodo_territoriale_id)
  }));
  const initialCorridors = [...latest.values()].map((c, i) => {
    const nodes = c.nodi.map(nodeId);
    check(c.engine_id === `territorial:${nodes.join('>')}`, `engine_id incoerente: ${c.engine_id}`);
    return {
      id: `px-${i + 1}`,
      nodes,
      legs: c.legs,
      richiestaIds: [],
      versione: Number(c.versione)
    };
  });

  const allNodeIds = new Set();
  for (const c of initialCorridors) for (const id of c.nodes) allNodeIds.add(id);
  for (const r of requests) {
    allNodeIds.add(r.origine_nodo_territoriale_id);
    allNodeIds.add(r.destinazione_nodo_territoriale_id);
  }
  const nodeRows = allNodeIds.size ? (await db.query(`
    SELECT id, ST_Y(posizione::geometry) AS lat, ST_X(posizione::geometry) AS lon
    FROM public.nodi_territoriali
    WHERE id = ANY($1::bigint[]) AND attivo = TRUE`, [[...allNodeIds]])).rows : [];
  const nodeMap = new Map(nodeRows.map(n => [nodeId(n.id), {
    id: nodeId(n.id), lat: Number(n.lat), lon: Number(n.lon)
  }]));
  check(nodeMap.size === allNodeIds.size, 'nodi territoriali mancanti o inattivi');

  const routeNodes = async ids => {
    const legs = [];
    for (let i = 0; i < ids.length - 1; i++) {
      const a = nodeMap.get(nodeId(ids[i]));
      const b = nodeMap.get(nodeId(ids[i + 1]));
      check(a && b, 'nodo routing mancante');
      const result = await leg(a, b);
      check(result && Number.isFinite(result.metres) && result.metres > 0 &&
        Number.isFinite(result.seconds) && result.seconds > 0 &&
        typeof result.polyline === 'string' && result.polyline.length > 0,
      `routing non verificato ${ids[i]} -> ${ids[i + 1]}`);
      legs.push({ metres: result.metres, seconds: result.seconds,
        polyline: result.polyline, roadCoincident: false });
    }
    return { verificataRouting: true, legs };
  };

  const engine = createIncrementalCorridorEngine({
    routeNodes, initialCorridors, abilitaVariantiP1,
    tolleranzaMinuti: 30, maxVariantiPerRichiesta: 12, maxNodiVariante: 8
  });
  const elaborazioni = [];
  for (const r of requests) {
    const result = await engine.processRequest(r);
    elaborazioni.push({ richiestaId: r.id, azione: result.azione,
      direttrici: result.direttrici, variantiP1: result.variantiP1 ?? [] });
  }
  const corridors = engine.listCorridors();
  const opportunita = [];
  for (const c of corridors) {
    const gruppi = await engine.temporalCandidatesCompleteWithReturns(c.id, { bufferMinuti });
    opportunita.push({ engineId: `territorial:${c.nodes.join('>')}`,
      idTemporaneo: c.id, nodes: [...c.nodes], richiestaIds: [...c.richiestaIds],
      gruppiTemporali: gruppi.length });
  }
  const riepilogo = {
    solaLettura: true,
    richiesteEsaminate: requests.length,
    direttriciRipristinate: initialCorridors.length,
    direttriciRisultanti: corridors.length,
    nuoveDirettrici: corridors.length - initialCorridors.length,
    opportunitaCandidate: opportunita.reduce((sum, x) => sum + x.gruppiTemporali, 0),
    elaborazioni, opportunita
  };
  return { engine, riepilogo };
}

export async function diagnosticaBootstrapPixel(options = {}) {
  const { riepilogo } = await costruisciBootstrapPixel(options);
  return riepilogo;
}
