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
const isV2 = (x) => x?.schemaVersion === 2 && x?.tipoItinerario === 'FERMATE_FISICHE';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function nodiValidi(a, nome) {
  if (!Array.isArray(a) || a.length < 2) throw new Error(`${nome} non validi`);
  return a.map(n => interoPositivo(n, nome));
}
function validaContrattoV2(m, piano, i) {
  if (!isV2(m) || !isV2(piano)) throw new Error(`Missione ${i + 1}: contratto V2 incompleto`);
  const nodiTerritoriali = nodiValidi(m.nodiTerritoriali, 'nodiTerritoriali');
  interoPositivo(m.pixelOpportunitaId, 'pixelOpportunitaId');
  interoPositivo(m.pixelDirettriceId, 'pixelDirettriceId');
  interoPositivo(m.pixelVersione, 'pixelVersione');
  if (typeof m.corridoioPixelId !== 'string' || !m.corridoioPixelId.trim())
    throw new Error(`Missione ${i + 1}: engine ID PIXEL mancante`);
  if (m.direttriceId != null) throw new Error('Missione PIXEL con direttrice virtuale legacy');
  return nodiTerritoriali;
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
    if (isV2(piano) && !same(m.legs, piano.legs.slice(base, endIndex)))
      throw new Error(`Missione ${i + 1}: tratte fisiche globali discordanti`);
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

// Validazione PIXEL nella transazione del chiamante. I lock impediscono
// cambiamenti concorrenti alle righe esistenti fino al COMMIT/ROLLBACK.
// Non sostituisce la rivalidazione delle richieste e dei veicoli nel worker.
async function verificaOpportunitaPixel(client, m, richieste, nodes) {
  const id = interoPositivo(m.pixelOpportunitaId, 'pixelOpportunitaId');
  const { rows } = await client.query(`
    SELECT o.id, o.stato AS opportunita_stato, o.direttrice_id,
           d.stato AS direttrice_stato, d.nodi, d.engine_id, d.versione
    FROM public.pixel_opportunita o
    JOIN public.pixel_direttrici d ON d.id = o.direttrice_id
    WHERE o.id = $1
    FOR SHARE OF o, d
  `, [id]);
  const op = rows[0];
  if (!op || op.opportunita_stato !== 'candidata' || op.direttrice_stato !== 'attiva')
    throw new Error(`Opportunita PIXEL ${id} non attiva/candidata`);
  const corridoio = op.nodi.map(Number);
  if (corridoio.length !== nodes.length || corridoio.some((n, i) => n !== nodes[i]))
    throw new Error(`Opportunita PIXEL ${id}: sequenza nodi discordante`);
  if (m.corridoioPixelId != null && String(m.corridoioPixelId) !== String(op.engine_id))
    throw new Error(`Opportunita PIXEL ${id}: engine_id discordante`);
  if (m.pixelDirettriceId != null && Number(m.pixelDirettriceId) !== Number(op.direttrice_id))
    throw new Error(`Opportunita PIXEL ${id}: direttrice_id discordante`);
  if (m.pixelVersione != null && Number(m.pixelVersione) !== Number(op.versione))
    throw new Error(`Opportunita PIXEL ${id}: versione discordante`);
  const { rows: associazioni } = await client.query(`
    SELECT richiesta_id
    FROM public.pixel_opportunita_richieste
    WHERE opportunita_id = $1
    ORDER BY richiesta_id
    FOR SHARE
  `, [id]);
  const ammesse = new Set(associazioni.map(r => Number(r.richiesta_id)));
  if (richieste.some(r => !ammesse.has(r.id)))
    throw new Error(`Opportunita PIXEL ${id}: richieste non associate`);
  return { id, engineId: String(op.engine_id), versione: Number(op.versione), direttriceId: Number(op.direttrice_id) };
}

export async function registraMissioniAttivazione(client, { attivazioneId, missioni, pianoGlobale = null }) {
  if (!client || typeof client.query !== 'function') throw new Error('Client PostgreSQL richiesto');
  const aid = interoPositivo(attivazioneId, 'attivazioneId');
  if (!Array.isArray(missioni) || missioni.length === 0) throw new Error('Missioni mancanti');
  // Prevalidazione COMPLETA: impedisce scritture parziali per errori strutturali.
  const globali = pianoGlobale == null ? null : validaMappingGlobale(missioni, pianoGlobale);
  const tutteRichieste = new Set();
  const opportunitaViste = new Set();
  const v2Globale = isV2(pianoGlobale);
  if (pianoGlobale && !v2Globale &&
      (pianoGlobale.schemaVersion === 2 || pianoGlobale.tipoItinerario === 'FERMATE_FISICHE'))
    throw new Error('Contratto globale V2 incompleto');
  const ids = [];
  const preparate = [];
  let ultimaFine = -Infinity;
  for (let i = 0; i < missioni.length; i++) {
    const m = missioni[i];
    if (!m || !Array.isArray(m.nodes) || m.nodes.length < 2 ||
        !Array.isArray(m.legs) || m.legs.length !== m.nodes.length - 1 ||
        !Array.isArray(m.requests) || m.requests.length === 0) {
      throw new Error(`Missione ${i + 1} non valida`);
    }
    if (v2Globale !== isV2(m) || (!v2Globale &&
        (m.schemaVersion === 2 || m.tipoItinerario === 'FERMATE_FISICHE')))
      throw new Error(`Missione ${i + 1}: contratto V1/V2 discordante`);
    const nodes = m.nodes.map(n => interoPositivo(n, v2Globale ? 'fermata fisica' : 'nodo territoriale'));
    const nodiTerritoriali = v2Globale ? validaContrattoV2(m, pianoGlobale, i) : nodes;
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
    // Il percorso PIXEL non puo' usare contemporaneamente una direttrice legacy.
    const pixel = m.pixelOpportunitaId == null ? null :
      await verificaOpportunitaPixel(client, m, richieste, nodiTerritoriali);
    if (pixel && m.direttriceId != null)
      throw new Error('Missione PIXEL con direttrice virtuale legacy');
    if (!pixel && m.corridoioPixelId != null)
      throw new Error('Riferimento corridoio PIXEL senza pixelOpportunitaId');
    if (pixel) {
      if (opportunitaViste.has(pixel.id)) throw new Error('Opportunita PIXEL duplicata');
      opportunitaViste.add(pixel.id);
    }
    preparate.push({ m, nodes, nodiTerritoriali, partenza, arrivo, richieste, pixel });
  }
  // Solo dopo che TUTTE le missioni hanno superato il preflight si scrive.
  // Il chiamante deve mantenere una transazione aperta e fare ROLLBACK su errore.
  for (let i = 0; i < preparate.length; i++) {
    const { m, nodes, nodiTerritoriali, partenza, arrivo, richieste, pixel } = preparate[i];
    const { rows } = await client.query(`
      INSERT INTO public.popbus_attivazione_missioni
        (attivazione_id, ordine, direttrice_id, corridoio_pixel_id,
         nodi_territoriali, partenza, arrivo, piano, pixel_opportunita_id)
      VALUES ($1,$2,$3,$4,$5::bigint[],$6,$7,$8::jsonb,$9)
      RETURNING id
    `, [aid, i + 1, m.direttriceId ?? null, pixel?.engineId ?? null,
      nodiTerritoriali, partenza, arrivo, JSON.stringify({
        ...(v2Globale ? { schemaVersion: 2, tipoItinerario: 'FERMATE_FISICHE' } : {}),
        nodes, legs: m.legs, requests: richieste,
        ...(pixel ? { pixel: {
          opportunitaId: pixel.id, direttriceId: pixel.direttriceId, versione: pixel.versione,
          ...(v2Globale ? { engineId: pixel.engineId, nodiTerritoriali } : {})
        } } : {})
      }),
      pixel?.id ?? null]);
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
