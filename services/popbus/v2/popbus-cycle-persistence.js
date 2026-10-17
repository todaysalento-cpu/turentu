// TURENTU POPBUS V2 - persistenza relazionale missioni del ciclo.
// Deve essere chiamata DENTRO la transazione che ha creato popbus_attivazioni.
// Non apre transazioni, non emette socket, non modifica richieste o pagamenti.
function interoPositivo(v, nome) {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${nome} non valido`);
  return n;
}
function istante(v, nome) {
  const d = new Date(v);
  if (!Number.isFinite(d.getTime())) throw new Error(`${nome} non valido`);
  return d;
}
// pianoGlobale e' opzionale per non alterare le attivazioni mono-missione legacy.
// Quando fornito, deve provenire dall'assembler e viene validato prima di ogni INSERT.
function validaMappingGlobale(missioni, piano) {
  if (!piano || !Array.isArray(piano.nodes) || !Array.isArray(piano.legs) ||
      piano.nodes.length < 2 || piano.legs.length !== piano.nodes.length - 1 ||
      !Array.isArray(piano.missioni) || piano.missioni.length !== missioni.length ||
      !Array.isArray(piano.evaluation?.requests)) {
    throw new Error('Piano globale incompleto');
  }
  const n = piano.nodes.length;
  const byId = new Map();
  for (const r of piano.evaluation.requests) {
    const id = interoPositivo(r.id, 'richiesta globale');
    const start = Number(r.start), end = Number(r.end);
    if (byId.has(id) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
        start < 0 || end <= start || end >= n) throw new Error('Indici globali non validi');
    byId.set(id, { id, start, end });
  }
  const expected = new Set();
  for (let i = 0; i < missioni.length; i++) {
    const m = missioni[i], meta = piano.missioni[i];
    const base = Number(meta?.startIndex), endIndex = Number(meta?.endIndex);
    if (Number(meta?.ordine) !== i + 1 || !Number.isSafeInteger(base) ||
        !Number.isSafeInteger(endIndex) || base < 0 || endIndex !== base + m.nodes.length - 1 ||
        endIndex >= n) throw new Error(`Missione ${i + 1}: offset globale non valido`);
    for (let j = 0; j < m.nodes.length; j++) {
      if (Number(piano.nodes[base + j]) !== Number(m.nodes[j]))
        throw new Error(`Missione ${i + 1}: nodi globali discordanti`);
    }
    for (const r of m.requests) {
      const id = interoPositivo(r.id, 'richiesta');
      if (expected.has(id)) throw new Error('Richiesta duplicata');
      expected.add(id);
      const global = byId.get(id);
      if (!global || global.start !== base + Number(r.start) ||
          global.end !== base + Number(r.end))
        throw new Error(`Richiesta ${id}: mapping globale discordante`);
    }
  }
  if (expected.size !== byId.size) throw new Error('Richieste globali non corrispondenti');
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

export async function registraMissioniAttivazione(client, { attivazioneId, missioni, pianoGlobale = null }) {
  if (!client || typeof client.query !== 'function') throw new Error('Client PostgreSQL richiesto');
  const aid = interoPositivo(attivazioneId, 'attivazioneId');
  if (!Array.isArray(missioni) || missioni.length === 0) throw new Error('Missioni mancanti');
  // Prevalidazione COMPLETA: impedisce scritture parziali per errori strutturali.
  const globali = pianoGlobale == null ? null : validaMappingGlobale(missioni, pianoGlobale);
  const tutteRichieste = new Set();
  const ids = [];
  let ultimaFine = -Infinity;
  for (let i = 0; i < missioni.length; i++) {
    const m = missioni[i];
    if (!m || !Array.isArray(m.nodes) || m.nodes.length < 2 ||
        !Array.isArray(m.legs) || m.legs.length !== m.nodes.length - 1 ||
        !Array.isArray(m.requests) || m.requests.length === 0) {
      throw new Error(`Missione ${i + 1} non valida`);
    }
    const nodes = m.nodes.map(n => interoPositivo(n, 'nodo territoriale'));
    const partenza = istante(m.departure, 'partenza');
    const arrivo = istante(m.arrival, 'arrivo');
    if (arrivo <= partenza || partenza.getTime() < ultimaFine) {
      throw new Error(`Missione ${i + 1}: intervallo sovrapposto o non valido`);
    }
    ultimaFine = arrivo.getTime();
    const richieste = m.requests.map(r => ({
      id: interoPositivo(r.id, 'richiesta'),
      start: Number(r.start), end: Number(r.end)
    }));
    for (const r of richieste) {
      if (!Number.isSafeInteger(r.start) || !Number.isSafeInteger(r.end) ||
          r.start < 0 || r.end <= r.start || r.end >= nodes.length || tutteRichieste.has(r.id)) {
        throw new Error(`Missione ${i + 1}: indici o richiesta duplicata`);
      }
      tutteRichieste.add(r.id);
    }
    // Nessuna scrittura finche' la struttura della missione corrente non e' valida.
    const { rows } = await client.query(`
      INSERT INTO public.popbus_attivazione_missioni
        (attivazione_id, ordine, direttrice_id, corridoio_pixel_id,
         nodi_territoriali, partenza, arrivo, piano)
      VALUES ($1,$2,$3,$4,$5::bigint[],$6,$7,$8::jsonb)
      RETURNING id
    `, [aid, i + 1, m.direttriceId ?? null, m.corridoioPixelId ?? null,
      nodes, partenza, arrivo, JSON.stringify({ nodes, legs: m.legs, requests: richieste })]);
    const missioneId = rows[0]?.id;
    if (!missioneId) throw new Error('Inserimento missione senza ID');
    ids.push(missioneId);
    for (const r of richieste) {
      await client.query(`
        INSERT INTO public.popbus_missione_richieste
          (missione_id, richiesta_id, indice_salita, indice_discesa)
        VALUES ($1,$2,$3,$4)
      `, [missioneId, r.id, r.start, r.end]);
    }
  }
  // Associazioni globali solo per il nuovo percorso. La funzione deve essere
  // eseguita nella stessa transazione che crea l'attivazione: rollback al chiamante.
  if (globali) {
    for (const r of globali) {
      await client.query(`
        INSERT INTO public.popbus_attivazione_richieste
          (attivazione_id, richiesta_id, indice_salita, indice_discesa)
        VALUES ($1,$2,$3,$4)
      `, [aid, r.id, r.start, r.end]);
    }
  }
  return ids;
}
