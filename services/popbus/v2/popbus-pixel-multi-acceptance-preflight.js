// TURENTU - PATCH MIRATA P0-C6 (V1 invariato, V2 esplicito).
// Sostituire SOLO services/popbus/v2/popbus-pixel-multi-acceptance-preflight.js
// Testare prima con il mock RED e test negativi. Nessuna query di scrittura.
// TURENTU P0-C6 ÔÇö preflight PIXEL multimissione, solo letture e lock.
// Richiede transazione del chiamante. Nessun accesso Stripe, nessun INSERT.
const fail = (message) => { throw new Error(`PIXEL_MULTI_ACCEPTANCE: ${message}`); };
const positive = (value, name) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) fail(`${name} non valido`);
  return n;
};
const nonnegative = (value, name) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) fail(`${name} non valido`);
  return n;
};
const sameArray = (a, b) => Array.isArray(a) && Array.isArray(b) &&
  a.length === b.length && a.every((v, i) => Number(v) === Number(b[i]));

export async function verificaAccettazionePixelMulti(client, attivazione, plan) {
  if (!client || typeof client.query !== 'function') fail('client PostgreSQL mancante');
  const aid = positive(attivazione?.id, 'attivazione');
  // Il ramo V2 e' esplicito: mai inferirlo da ID o forme delle sequenze.
  const physical = plan?.schemaVersion === 2 && plan?.tipoItinerario === 'FERMATE_FISICHE';
  if ((plan?.schemaVersion === 2 || plan?.tipoItinerario === 'FERMATE_FISICHE') && !physical)
    fail('contratto V2 incompleto');
  if (attivazione.direttrice_id != null) fail('direttrice legacy nell attivazione');
  if (!Array.isArray(plan?.missioni) || plan.missioni.length < 2 || plan.missioni.length > 3 ||
      !Array.isArray(plan.nodes) || !Array.isArray(plan.legs) ||
      plan.legs.length !== plan.nodes.length - 1 ||
      !Array.isArray(plan.evaluation?.requests)) fail('piano globale non valido');

  const { rows: missions } = await client.query(`
    SELECT id, ordine, direttrice_id, pixel_opportunita_id, corridoio_pixel_id,
           nodi_territoriali, piano
    FROM public.popbus_attivazione_missioni
    WHERE attivazione_id = $1
    ORDER BY ordine FOR SHARE
  `, [aid]);
  if (missions.length !== plan.missioni.length) fail('numero missioni discordante');
  const globalExpected = new Map();
  for (const r of plan.evaluation.requests) {
    const rid = positive(r.id, 'richiesta globale');
    const start = nonnegative(r.start, 'salita globale');
    const end = nonnegative(r.end, 'discesa globale');
    if (globalExpected.has(rid) || start >= end || end >= plan.nodes.length)
      fail('mapping globale non valido');
    globalExpected.set(rid, { start, end });
  }
  const allLocal = new Map();
  const opportunityIds = new Set();
  for (let i = 0; i < missions.length; i++) {
    const m = missions[i];
    const meta = plan.missioni[i];
    if (Number(m.ordine) !== i + 1 || m.direttrice_id != null)
      fail(`missione ${i + 1}: ordine o direttrice legacy`);
    const oid = positive(m.pixel_opportunita_id, `missione ${i + 1} opportunita`);
    if (opportunityIds.has(oid)) fail('opportunita PIXEL ripetuta');
    opportunityIds.add(oid);
    const start = nonnegative(meta?.startIndex, 'startIndex');
    const end = nonnegative(meta?.endIndex, 'endIndex');
    const nodes = m.nodi_territoriali;
    if (end < start || end >= plan.nodes.length) fail(`missione ${i + 1}: indici missione invalidi`);
    const physicalNodes = plan.nodes.slice(start, end + 1);
    if (!physical && !sameArray(nodes, physicalNodes))
      fail(`missione ${i + 1}: nodi globali discordanti`);
    const payload = typeof m.piano === 'string' ? JSON.parse(m.piano) : m.piano;
    if (!payload || !Array.isArray(payload.legs) || !Array.isArray(payload.requests))
      fail(`missione ${i + 1}: payload non valido`);
    if (physical) {
      if (payload.schemaVersion !== 2 || payload.tipoItinerario !== 'FERMATE_FISICHE' ||
          !sameArray(payload.nodes, physicalNodes) ||
          !sameArray(payload.pixel?.nodiTerritoriali, nodes) ||
          payload.legs.length !== physicalNodes.length - 1)
        fail(`missione ${i + 1}: payload fisico/territoriale non valido`);
    } else if (!sameArray(payload.nodes, nodes) || payload.legs.length !== nodes.length - 1) {
      fail(`missione ${i + 1}: payload non valido`);
    }
    for (let j = 0; j < payload.legs.length; j++) {
      const local = payload.legs[j], global = plan.legs[start + j];
      if (!local || !global || String(local.polyline) !== String(global.polyline) ||
          Number(local.seconds) !== Number(global.seconds) ||
          Number(local.metres) !== Number(global.metres))
        fail(`missione ${i + 1}: geometria discordante`);
    }
    const { rows: opportunities } = await client.query(`
      SELECT o.id, o.stato AS opportunita_stato, d.id AS direttrice_id,
             d.stato AS direttrice_stato, d.nodi, d.engine_id, d.versione
      FROM public.pixel_opportunita o
      JOIN public.pixel_direttrici d ON d.id = o.direttrice_id
      WHERE o.id = $1 FOR SHARE OF o, d
    `, [oid]);
    const op = opportunities[0];
    if (!op || op.opportunita_stato !== 'candidata' || op.direttrice_stato !== 'attiva')
      fail(`missione ${i + 1}: opportunita o direttrice non attiva`);
    if (!sameArray(op.nodi, nodes)) fail(`missione ${i + 1}: direttrice modificata`);
    if (String(m.corridoio_pixel_id) !== String(op.engine_id))
      fail(`missione ${i + 1}: engine_id discordante`);
    const snapshot = payload.pixel;
    if (!snapshot || Number(snapshot.opportunitaId) !== oid ||
        Number(snapshot.direttriceId) !== Number(op.direttrice_id) ||
        Number(snapshot.versione) !== Number(op.versione) ||
        (physical && (String(snapshot.engineId) !== String(op.engine_id) ||
          !sameArray(snapshot.nodiTerritoriali, op.nodi))))
      fail(`missione ${i + 1}: identita o versione PIXEL modificata`);
    const { rows: associations } = await client.query(`
      SELECT richiesta_id FROM public.pixel_opportunita_richieste
      WHERE opportunita_id = $1 ORDER BY richiesta_id FOR SHARE
    `, [oid]);
    const allowed = new Set(associations.map(r => positive(r.richiesta_id, 'richiesta PIXEL')));
    for (const r of payload.requests) {
      const rid = positive(r.id, 'richiesta locale');
      const localStart = nonnegative(r.start, 'salita locale');
      const localEnd = nonnegative(r.end, 'discesa locale');
      const expected = globalExpected.get(rid);
      if (!allowed.has(rid) || allLocal.has(rid) || localStart >= localEnd ||
          localEnd >= (physical ? physicalNodes.length : nodes.length) || !expected ||
          expected.start !== start + localStart || expected.end !== start + localEnd)
        fail(`missione ${i + 1}: associazione o indici richiesta ${rid} invalidi`);
      allLocal.set(rid, { missionId: Number(m.id), localStart, localEnd });
    }
  }
  if (allLocal.size !== globalExpected.size) fail('richieste locali/globali incomplete');
  const { rows: locals } = await client.query(`
    SELECT mr.missione_id, mr.richiesta_id, mr.indice_salita, mr.indice_discesa
    FROM public.popbus_missione_richieste mr
    JOIN public.popbus_attivazione_missioni m ON m.id = mr.missione_id
    WHERE m.attivazione_id = $1 FOR SHARE OF mr, m
  `, [aid]);
  if (locals.length !== allLocal.size) fail('associazioni locali DB incomplete');
  const seenLocal = new Set();
  for (const r of locals) {
    const rid = positive(r.richiesta_id, 'richiesta locale DB');
    const expected = allLocal.get(rid);
    if (!expected || seenLocal.has(rid) || Number(r.missione_id) !== expected.missionId ||
        Number(r.indice_salita) !== expected.localStart ||
        Number(r.indice_discesa) !== expected.localEnd)
      fail('associazioni locali DB discordanti');
    seenLocal.add(rid);
  }
  const { rows: globals } = await client.query(`
    SELECT richiesta_id, indice_salita, indice_discesa, attiva
    FROM public.popbus_attivazione_richieste
    WHERE attivazione_id = $1 FOR SHARE
  `, [aid]);
  if (globals.length !== globalExpected.size) fail('associazioni globali DB incomplete');
  const seenGlobal = new Set();
  for (const r of globals) {
    const rid = positive(r.richiesta_id, 'richiesta globale DB');
    const expected = globalExpected.get(rid);
    if (!expected || seenGlobal.has(rid) || r.attiva !== true ||
        Number(r.indice_salita) !== expected.start ||
        Number(r.indice_discesa) !== expected.end)
      fail('associazioni globali DB discordanti');
    seenGlobal.add(rid);
  }
  return { missioni: missions.length, opportunita: opportunityIds.size, richieste: allLocal.size };
}
