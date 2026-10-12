import { getRouteGeometry } from '../../utils/maps.util.js';

export const TOLLERANZA_SALITA_MINUTI = 30;

export function verificaSalita(segmenti, partenza, richiesta) {
  if (!segmenti.length) return null;
  const nodes = [Number(segmenti[0].start_node_id)];
  const times = [new Date(partenza).getTime()];
  if (!Number.isFinite(times[0])) return null;
  for (let i = 0; i < segmenti.length; i++) {
    const s = segmenti[i];
    const durata = s.tempo_stimato == null ? NaN : Number(s.tempo_stimato);
    if (Number(s.ordine_sequenziale) !== i + 1 ||
        Number(s.start_node_id) !== nodes[i] || !Number.isFinite(durata) || durata <= 0) return null;
    // Il tempo cumulato è la fonte del transito; un timestamp incoerente blocca il matching.
    if (s.start_datetime != null && new Date(s.start_datetime).getTime() !== times[i]) return null;
    nodes.push(Number(s.end_node_id));
    times.push(times[i] + durata * 60000);
  }
  if (new Set(nodes).size !== nodes.length) return null;
  const start = nodes.indexOf(Number(richiesta.start_node_id));
  const end = nodes.indexOf(Number(richiesta.end_node_id));
  const requested = new Date(richiesta.start_datetime).getTime();
  if (start < 0 || end <= start || !Number.isFinite(requested)) return null;
  const scarto = Math.abs(times[start] - requested);
  return scarto <= TOLLERANZA_SALITA_MINUTI * 60000
    ? { start, end, scarto, transito: times[start], nodes, times } : null;
}

async function durataStradale(client, start, end) {
  const { rows } = await client.query(`
    SELECT id, ST_Y(posizione::geometry) AS lat, ST_X(posizione::geometry) AS lon
    FROM nodi_direttrice WHERE id = ANY($1::int[])
  `, [[start, end]]);
  const a = rows.find(n => Number(n.id) === start);
  const b = rows.find(n => Number(n.id) === end);
  if (!a || !b) return null;
  try {
    const route = await getRouteGeometry({lat:a.lat, lon:a.lon}, {lat:b.lat, lon:b.lon});
    const seconds = Number(route.durata);
    return Number.isFinite(seconds) && seconds > 0 ? Math.max(1, Math.ceil(seconds / 60)) : null;
  } catch (err) {
    console.warn(`[POPBUS] Tratta ${start} → ${end} rinviata: ${err.message}`);
    return null; // Nessun tempo arbitrario usato per dichiarare compatibilità.
  }
}

export async function gestisciMatchingEDirettrici(client, allClusters) {
  // Lock cooperativo per l'intera transazione del worker; prima di qualsiasi mutazione.
  await client.query('SELECT pg_advisory_xact_lock(734021, 1)');
  const candidates = new Map();
  for (const c of allClusters) {
    if (c.is_composta) continue;
    if (!Array.isArray(c.richieste)) throw new Error('Aggiornare anche clusterService.js: mancano gli ID delle richieste');
    for (const r of c.richieste) candidates.set(String(r.id), { ...r, fascia: c.fascia_percorrenza });
  }
  const richieste = [...candidates.values()].sort((a,b) =>
    new Date(a.start_datetime) - new Date(b.start_datetime) || String(a.id).localeCompare(String(b.id)));
  const coinvolti = new Set();
  for (const candidate of richieste) {
    const { rows: fresh } = await client.query(`
      SELECT id, start_node_id, end_node_id, start_datetime, posti_richiesti
      FROM richieste_pop_bus WHERE id = $1 AND stato = 'in_attesa'
        AND direttrice_id IS NULL FOR UPDATE
    `, [candidate.id]);
    if (!fresh.length) continue;
    const r = fresh[0];
    const start = Number(r.start_node_id), end = Number(r.end_node_id), posti = Number(r.posti_richiesti);
    if (start === end || r.start_datetime == null || !Number.isInteger(posti) || posti <= 0) continue;
    const servizio = `STANDARD_${candidate.fascia}`;
    const { rows: dirs } = await client.query(`
      SELECT id, partenza_prevista FROM direttrici_virtuali
      WHERE tipo_servizio = $1 AND stato = 'in_formazione'
      ORDER BY partenza_prevista, id FOR UPDATE
    `, [servizio]);
    let chosen = null;
    for (const d of dirs) {
      const { rows: segments } = await client.query(`
        SELECT id, start_node_id, end_node_id, ordine_sequenziale,
               tempo_stimato, start_datetime, stato, posti_impegnati
        FROM segmenti WHERE direttrice_id = $1 ORDER BY ordine_sequenziale, id FOR UPDATE
      `, [d.id]);
      if (!segments.length || segments.some(s => s.stato !== 'in_attesa' || Number(s.posti_impegnati || 0) !== 0)) continue;
      let trial = segments;
      let append = null;
      // Estensione solo al capolinea: nessun riordino o spostamento dei transiti precedenti.
      if (Number(segments.at(-1).end_node_id) === start &&
          !segments.some(s => Number(s.start_node_id) === end || Number(s.end_node_id) === end)) {
        const { rows: protectedReturns } = await client.query(`
          SELECT m.id FROM missioni_ritorno m
          WHERE m.direttrice_id=$1 AND (
            m.stato IS DISTINCT FROM 'in_attesa' OR EXISTS (
              SELECT 1 FROM richieste_pop_bus r WHERE r.target_missione_id=m.id
            )
          ) LIMIT 1
        `, [d.id]);
        if (protectedReturns.length) continue;
        const durata = await durataStradale(client, start, end);
        if (durata == null) continue;
        append = {start_node_id:start, end_node_id:end, tempo_stimato:durata,
          ordine_sequenziale:segments.length + 1, start_datetime:null};
        trial = [...segments, append];
      }
      const validation = verificaSalita(trial, d.partenza_prevista, r);
      if (validation && (!chosen || validation.scarto < chosen.validation.scarto)) {
        chosen = { d, segments, append, validation };
      }
    }
    if (!chosen) {
      const durata = await durataStradale(client, start, end);
      if (durata == null) continue;
      const { rows: inserted } = await client.query(`
        INSERT INTO direttrici_virtuali (stato, partenza_prevista, start_node_id, end_node_id, tipo_servizio)
        VALUES ('in_formazione', $1, $2, $3, $4)
        ON CONFLICT (start_node_id, end_node_id, partenza_prevista) DO NOTHING RETURNING id, partenza_prevista
      `, [r.start_datetime, start, end, servizio]);
      // Non riattivare né sovrascrivere una direttrice già presente.
      if (!inserted.length) continue;
      const append = {start_node_id:start, end_node_id:end, tempo_stimato:durata,
        ordine_sequenziale:1, start_datetime:null};
      chosen = {d:inserted[0], segments:[], append,
        validation:verificaSalita([append], r.start_datetime, r)};
    }
    const { d, validation } = chosen;
    if (chosen.append) {
      const s = chosen.append;
      const segmentStart = new Date(validation.times[s.ordine_sequenziale - 1]);
      const { rows: added } = await client.query(`
        INSERT INTO segmenti (direttrice_id, start_node_id, end_node_id, posti_occupati,
          stato, ordine_sequenziale, tempo_stimato, start_datetime)
        VALUES ($1,$2,$3,0,'in_attesa',$4,$5,$6) RETURNING id
      `, [d.id, s.start_node_id, s.end_node_id, s.ordine_sequenziale, s.tempo_stimato, segmentStart]);
      chosen.segments.push({...s, id:added[0].id});
      await client.query('UPDATE direttrici_virtuali SET end_node_id = $1 WHERE id = $2', [end, d.id]);
      await client.query(`
        UPDATE missioni_ritorno SET capolinea_finale_id=$1
        WHERE direttrice_id=$2 AND stato='in_attesa'
      `, [end,d.id]);
      const fascia = candidate.fascia;
      const ritorno = fascia === 'alta' ? 30 : fascia === 'media' ? 20 : 10;
      const attesa = fascia === 'alta' ? 40 : fascia === 'media' ? 25 : 15;
      // Mantiene la regola di ritorno esistente; cambia solo il riferimento alla partenza effettiva.
      await client.query(`
        INSERT INTO missioni_ritorno (segmento_id,direttrice_id,nodo_origine,capolinea_finale_id,
          orario_previsto,stato,tempo_max_attesa)
        VALUES ($1,$2,$3,$3,$4::timestamptz + $5::double precision * INTERVAL '1 minute','in_attesa',$6)
        ON CONFLICT (segmento_id,capolinea_finale_id) DO NOTHING
      `, [added[0].id, d.id, end, d.partenza_prevista, ritorno, attesa]);
      // Gli ID e gli stati rimangono invariati; estensione esclusa per ritorni già collegati a richieste.
    }
    const { rows: associated } = await client.query(`
      UPDATE richieste_pop_bus SET direttrice_id=$1, stato='in_lavorazione'
      WHERE id=$2 AND stato='in_attesa' AND direttrice_id IS NULL RETURNING id
    `, [d.id, r.id]);
    if (associated.length !== 1) throw new Error(`Associazione concorrente richiesta ${r.id}`);
    for (let i = validation.start; i < validation.end; i++) {
      const s = chosen.segments[i];
      await client.query(`
        UPDATE segmenti SET posti_occupati=COALESCE(posti_occupati,0)+$1
        WHERE id=$2
      `, [posti, s.id]);
      coinvolti.add(Number(s.id));
    }
  }
  return [...coinvolti];
}
