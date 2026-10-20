// Turentu POPBUS V2 — preflight PIXEL in acceptance.
// Usa la transazione del router; non apre transazioni e non scrive.
const fail = msg => { throw new Error(`PIXEL_ACCEPTANCE: ${msg}`); };
const integer = x => Number.isSafeInteger(Number(x)) && Number(x) > 0 ? Number(x) : null;

export async function verificaAccettazionePixel(client, attivazione, plan) {
  const opportunityId = integer(attivazione?.pixel_opportunita_id);
  if (!opportunityId) fail('ID opportunita mancante');
  if (attivazione.direttrice_id != null) fail('attivazione PIXEL collegata a direttrice legacy');
  if (!Array.isArray(plan?.nodes) || plan.nodes.length < 2 ||
      !Array.isArray(plan?.evaluation?.requests) || !plan.evaluation.requests.length) {
    fail('piano o richieste mancanti');
  }
  const { rows: opportunities } = await client.query(`
    SELECT o.id, o.stato AS opportunita_stato, d.id AS direttrice_id,
           d.stato AS direttrice_stato, d.nodi, d.versione
    FROM public.pixel_opportunita o
    JOIN public.pixel_direttrici d ON d.id = o.direttrice_id
    WHERE o.id = $1 FOR SHARE OF o, d
  `, [opportunityId]);
  const op = opportunities[0];
  if (!op || op.opportunita_stato !== 'candidata' || op.direttrice_stato !== 'attiva')
    fail('opportunita o direttrice non attiva');
  const nodes = plan.nodes.map(integer);
  if (nodes.some(x => x === null) || !Array.isArray(op.nodi) ||
      nodes.length !== op.nodi.length || nodes.some((n, i) => n !== Number(op.nodi[i])))
    fail('sequenza nodi PIXEL modificata');

  const { rows: missions } = await client.query(`
    SELECT pixel_opportunita_id, nodi_territoriali, piano
    FROM public.popbus_attivazione_missioni
    WHERE attivazione_id = $1 ORDER BY ordine
  `, [attivazione.id]);
  if (missions.length !== 1 || Number(missions[0].pixel_opportunita_id) !== opportunityId)
    fail('missione PIXEL persistita mancante o multipla');
  const missionNodes = missions[0].nodi_territoriali.map(Number);
  if (missionNodes.length !== nodes.length || missionNodes.some((n, i) => n !== nodes[i]))
    fail('nodi missione persistita discordanti');
  const persistedPixel = missions[0].piano?.pixel;
  if (!persistedPixel || Number(persistedPixel.opportunitaId) !== opportunityId ||
      Number(persistedPixel.direttriceId) !== Number(op.direttrice_id) ||
      Number(persistedPixel.versione) !== Number(op.versione))
    fail('versione o identita PIXEL modificata');

  const expected = new Map();
  for (const r of plan.evaluation.requests) {
    const id = integer(r.id);
    if (!id || expected.has(id) || !Number.isInteger(Number(r.start)) ||
        !Number.isInteger(Number(r.end)) || Number(r.start) < 0 ||
        Number(r.end) >= nodes.length || Number(r.end) <= Number(r.start))
      fail('richieste o indici del piano invalidi');
    expected.set(id, { start: Number(r.start), end: Number(r.end) });
  }
  const { rows: associations } = await client.query(`
    SELECT pr.richiesta_id, ar.indice_salita, ar.indice_discesa
    FROM public.popbus_attivazione_richieste ar
    JOIN public.pixel_opportunita_richieste pr
      ON pr.richiesta_id = ar.richiesta_id AND pr.opportunita_id = $2
    WHERE ar.attivazione_id = $1 AND ar.attiva
  `, [attivazione.id, opportunityId]);
  if (associations.length !== expected.size) fail('richieste PIXEL non associate o incomplete');
  const seen = new Set();
  for (const r of associations) {
    const id = Number(r.richiesta_id);
    const e = expected.get(id);
    if (!e || seen.has(id) || Number(r.indice_salita) !== e.start ||
        Number(r.indice_discesa) !== e.end) fail('richieste o indici discordanti');
    seen.add(id);
  }
  return { opportunitaId: opportunityId, direttriceId: Number(op.direttrice_id), richieste: seen.size };
}
