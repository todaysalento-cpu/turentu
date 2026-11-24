import { pool } from '../../db/db.js';

export async function listMissingEventImages() {
  const { rows } = await pool.query(`
    SELECT
      e.id,
      e.titolo,
      e.categoria,
      e.citta,
      e.luogo_nome,
      e.data_inizio,
      c.data AS discovery_data,
      s.nome AS image_source_name,
      s.dominio AS image_source_domain,
      ds.url AS source_url,
      ds.terms AS source_terms,
      COALESCE(
        s.ricerca_abilitata, false
      ) AS ricerca_abilitata,
      COALESCE(
        s.download_abilitato, false
      ) AS download_abilitato
    FROM public.eventi_senza_copertina e
    LEFT JOIN LATERAL (
      SELECT source_id, data
      FROM public.event_discovery_candidates
      WHERE event_id = e.id
      ORDER BY observed_at DESC, id DESC
      LIMIT 1
    ) c ON true
    LEFT JOIN public.event_discovery_sources ds
      ON ds.id = c.source_id
    LEFT JOIN public.event_image_sources s
      ON LOWER(s.dominio) = LOWER(ds.domain)
    ORDER BY e.data_inizio, e.id
  `);

  return rows.map(evento => ({
    ...evento,
    paginaEvento: evento.discovery_data?.url || null,
    statoRicerca: !evento.source_url
      ? 'FONTE_MANCANTE'
      : !evento.ricerca_abilitata
        ? 'FONTE_DA_AUTORIZZARE'
        : 'PRONTO_RICERCA'
  }));
}

export function normalizeEventTitle(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export async function groupMissingEventImages() {
  const events = await listMissingEventImages();
  const groups = new Map();

  for (const event of events) {
    const key = [
      event.categoria,
      normalizeEventTitle(event.titolo)
    ].join(':');

    if (!groups.has(key)) {
      groups.set(key, {
        titolo: event.titolo,
        categoria: event.categoria,
        eventi: [],
        citta: [],
        fonti: []
      });
    }

    const group = groups.get(key);

    group.eventi.push(event.id);

    if (
      event.citta &&
      !group.citta.includes(event.citta)
    ) {
      group.citta.push(event.citta);
    }

    if (
      event.source_url &&
      !group.fonti.includes(event.source_url)
    ) {
      group.fonti.push(event.source_url);
    }
  }

  return [...groups.values()].sort(
    (a, b) => b.eventi.length - a.eventi.length
  );
}