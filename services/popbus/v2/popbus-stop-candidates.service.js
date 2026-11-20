// services/popbus/v2/popbus-stop-candidates.service.js
// PIXEL -> POPBUS V2: selezione fermate candidate.
// Verifica/certificazione non obbligatoria nella fase provvisoria.
// Sola lettura: nessuna attivazione e nessuna scrittura DB.

export const DEFAULT_RADIUS_METERS = 1500;
export const DEFAULT_LIMIT = 5;

const fail = message => {
  throw new Error(`POPBUS_STOP_CANDIDATES: ${message}`);
};

export async function cercaFermateCandidate({
  client,
  richiestaIds,
  raggioMetri = DEFAULT_RADIUS_METERS,
  limite = DEFAULT_LIMIT
}) {
  if (!client || typeof client.query !== 'function') {
    fail('client PostgreSQL obbligatorio');
  }

  if (
    !Array.isArray(richiestaIds) ||
    !richiestaIds.length ||
    richiestaIds.some(
      id => !Number.isSafeInteger(Number(id)) || Number(id) <= 0
    )
  ) {
    fail('richiestaIds non validi');
  }

  if (
    !Number.isFinite(raggioMetri) ||
    raggioMetri <= 0 ||
    raggioMetri > 10000
  ) {
    fail('raggioMetri non valido');
  }

  if (
    !Number.isSafeInteger(limite) ||
    limite < 1 ||
    limite > 30
  ) {
    fail('limite non valido');
  }

  const ids = [...new Set(richiestaIds.map(Number))];

  const rows = await leggiFermateCandidate(client,
    `
    WITH richieste AS (
      SELECT id, origine, destinazione, origine_fermata_id, destinazione_fermata_id, start_datetime, origine_richiesta
      FROM public.richieste_pop_bus
      WHERE id = ANY($1::bigint[])
    ),
    punti AS (
      SELECT id AS richiesta_id, 'salita'::text AS tipo,
             origine::geography AS posizione, origine_fermata_id AS fermata_fissata,
             start_datetime + interval '12 hours' AS scadenza_minima, FALSE AS ricerca_prima_del_preventivo,
             COALESCE(origine_richiesta->'raccolta_google' = 'true'::jsonb, FALSE) AS raccolta_google,
             NULL::bigint AS nodo_richiesto
      FROM richieste

      UNION ALL

      SELECT id AS richiesta_id, 'discesa'::text AS tipo,
             destinazione::geography AS posizione, destinazione_fermata_id AS fermata_fissata,
             start_datetime + interval '12 hours' AS scadenza_minima, FALSE AS ricerca_prima_del_preventivo,
             FALSE AS raccolta_google, NULL::bigint AS nodo_richiesto
      FROM richieste
    )`, [ids, raggioMetri, limite]
  );

  const risultato = new Map(ids.map(id => [id, { richiesta_id: id, salita: [], discesa: [] }]));
  for (const row of rows) {
    risultato.get(Number(row.richiesta_id))?.[row.tipo].push(normalizzaFermata(row));
  }
  return [...risultato.values()].map(item => ({
    ...item,
    completa: item.salita.length > 0 && item.discesa.length > 0
  }));
}

export async function assegnaFermatePixel({
  client, origine, destinazione, origineNodoId, destinazioneNodoId, raccolta, scadenzaMinima = null,
  vincolaNodoSalita = false
}) {
  const rows = await cercaPerCoordinate(client, [
      ...(!raccolta ? [{ ...origine, tipo: 'salita', nodo_id: vincolaNodoSalita ? origineNodoId : null }] : []),
      { ...destinazione, tipo: 'discesa' }
  ], { raggioMetri: DEFAULT_RADIUS_METERS, limite: DEFAULT_LIMIT, scadenzaMinima });

  const salite = raccolta ? [{ ...raccolta, nodo_territoriale_id: raccolta.nodo_id }] :
    rows.filter(r => r.tipo === 'salita').map(normalizzaFermata);
  const discese = rows.filter(r => r.tipo === 'discesa').map(normalizzaFermata);
  for (const salita of salite) {
    const discesa = discese.find(d => d.nodo_territoriale_id !== salita.nodo_territoriale_id);
    if (discesa) return { salita, discesa };
  }
  const salita = salite.find(s => s.nodo_territoriale_id !== destinazioneNodoId) ?? null;
  if (salita) return { salita, discesa: null };
  return {
    salita: null,
    discesa: discese.find(d => d.nodo_territoriale_id !== origineNodoId) ?? null
  };
}

export async function cercaFermataLocalePixel({ client, nodoId, punto, raggioMetri = DEFAULT_RADIUS_METERS, scadenzaMinima }) {
  const [row] = await cercaPerCoordinate(client, [{ ...punto, tipo: 'salita', nodo_id: nodoId }], {
    raggioMetri, limite: 1, scadenzaMinima
  });
  return row ? normalizzaFermata(row) : null;
}

function cercaPerCoordinate(client, punti, { raggioMetri, limite, scadenzaMinima }) {
  return leggiFermateCandidate(client, `
    WITH punti AS (
      SELECT 1 AS richiesta_id, tipo,
             ST_SetSRID(ST_MakePoint(lon, lat), 4326)::geography AS posizione,
             NULL::bigint AS fermata_fissata, $4::timestamptz AS scadenza_minima,
             TRUE AS ricerca_prima_del_preventivo, FALSE AS raccolta_google, nodo_id AS nodo_richiesto
      FROM jsonb_to_recordset($1::jsonb) AS p(tipo text, lat float8, lon float8, nodo_id bigint)
    )`, [JSON.stringify(punti), raggioMetri, limite, scadenzaMinima]);
}

async function leggiFermateCandidate(client, ctePunti, parametri) {
  const { rows } = await client.query(`${ctePunti},
    candidate AS (
      SELECT
        p.richiesta_id,
        p.tipo,
        f.id AS fermata_id,
        f.nome,
        f.nodo_territoriale_id,
        f.tipi_veicolo_ammessi,
        f.verificata,
        f.google_place_id,
        ST_Y(f.posizione::geometry) AS lat,
        ST_X(f.posizione::geometry) AS lon,
        ST_Distance(p.posizione, f.posizione) AS distanza_metri,

        ROW_NUMBER() OVER (
          PARTITION BY p.richiesta_id, p.tipo
          ORDER BY (f.google_place_id IS NOT NULL), ST_Distance(p.posizione, f.posizione), f.id
        ) AS posizione_ordine

      FROM punti p

      JOIN public.pixel_fermate f
        ON f.attiva = TRUE
       AND (f.google_place_id IS NULL OR (
            p.scadenza_minima IS NOT NULL
            AND f.google_geo_scade_il > GREATEST(NOW(), p.scadenza_minima)
            AND (p.ricerca_prima_del_preventivo OR f.id = p.fermata_fissata)
       ))
       AND (p.fermata_fissata IS NULL OR f.id = p.fermata_fissata)
       AND (p.nodo_richiesto IS NULL OR f.nodo_territoriale_id = p.nodo_richiesto)
       AND ((p.raccolta_google AND f.google_place_id IS NOT NULL AND f.id = p.fermata_fissata) OR ST_DWithin(
         p.posizione,
         f.posizione,
         $2::double precision
       ))

      JOIN public.nodi_territoriali n
        ON n.id = f.nodo_territoriale_id
       AND n.attivo = TRUE

      WHERE p.posizione IS NOT NULL

        -- Esclusione delle fermate identificate come test.
        AND NOT EXISTS (
          SELECT 1
          FROM public.pixel_fermate_test_metadata tm
          WHERE tm.fermata_id = f.id
        )

        AND f.nome !~*
          '^[[:space:]]*(\\[TEST PIXEL\\]|TEST PIXEL([[:space:]]|$))'

        -- Una fonte negativa esclude la fermata.
        AND NOT EXISTS (
          SELECT 1
          FROM public.pixel_fermate_fonti ff
          WHERE ff.fermata_id = f.id
            AND ff.stato_verifica = 'non_ammessa'
        )
    )
    SELECT *
    FROM candidate
    WHERE posizione_ordine <= $3::integer
    ORDER BY richiesta_id, tipo, posizione_ordine
    `, parametri
  );
  return rows;
}

export function dettaglioFermataGoogle(placeId) {
    if (!placeId) return {};
    return {
      provvisoria: true,
      google_maps_url: 'https://www.google.com/maps/search/?' + new URLSearchParams({
        api: '1', query: 'fermata', query_place_id: placeId
      })
    };
}

function normalizzaFermata(row) {
    return {
      fermata_id: Number(row.fermata_id),
      nome: row.nome,
      nodo_territoriale_id: Number(row.nodo_territoriale_id),
      lat: Number(row.lat),
      lon: Number(row.lon),
      distanza_metri: Number(row.distanza_metri),
      verificata: row.verificata === true,
      ...dettaglioFermataGoogle(row.google_place_id),
      tipi_veicolo_ammessi: row.tipi_veicolo_ammessi
    };
}
// AGGIUNGERE a services/popbus/v2/popbus-stop-candidates.service.js
// Nuova funzione indipendente. Non modifica gli export esistenti.
// Restituisce candidate anagraficamente ammissibili, NON ancora selezionabili:
// Search deve verificare routing, deviazioni, missione e coppia salita/discesa.

export async function cercaFermateCandidateNodoPixel({
  client,
  nodoId,
  punto,
  scadenzaMinima = null,
  limite = 30
}) {
  if (!client || typeof client.query !== 'function') {
    fail('client PostgreSQL obbligatorio');
  }
  const id = Number(nodoId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    fail('nodoId non valido');
  }
  if (!punto || !Number.isFinite(Number(punto.lat)) ||
      !Number.isFinite(Number(punto.lon)) ||
      Number(punto.lat) < -90 || Number(punto.lat) > 90 ||
      Number(punto.lon) < -180 || Number(punto.lon) > 180) {
    fail('coordinate punto non valide');
  }
  if (!Number.isSafeInteger(limite) || limite < 1 || limite > 100) {
    fail('limite non valido');
  }
  if (scadenzaMinima !== null &&
      (!(scadenzaMinima instanceof Date) && typeof scadenzaMinima !== 'string' ||
       Number.isNaN(new Date(scadenzaMinima).getTime()))) {
    fail('scadenzaMinima non valida');
  }

  const { rows } = await client.query(`
    WITH riferimento AS (
      SELECT ST_SetSRID(ST_MakePoint($2::float8, $3::float8), 4326)::geography AS posizione
    )
    SELECT f.id AS fermata_id, f.nome, f.nodo_territoriale_id,
           f.tipi_veicolo_ammessi, f.verificata, f.google_place_id,
           ST_Y(f.posizione::geometry) AS lat,
           ST_X(f.posizione::geometry) AS lon,
           ST_Distance(f.posizione::geography, r.posizione) AS distanza_metri
    FROM public.pixel_fermate f
    JOIN public.nodi_territoriali n
      ON n.id = f.nodo_territoriale_id AND n.attivo = TRUE
    CROSS JOIN riferimento r
    WHERE f.nodo_territoriale_id = $1::bigint
      AND f.attiva = TRUE
      AND (f.google_place_id IS NULL OR
           ($4::timestamptz IS NOT NULL AND
            f.google_geo_scade_il > GREATEST(NOW(), $4::timestamptz)))
      AND NOT EXISTS (
        SELECT 1 FROM public.pixel_fermate_test_metadata tm
        WHERE tm.fermata_id = f.id
      )
      AND f.nome !~* '^[[:space:]]*(\\[TEST PIXEL\\]|TEST PIXEL([[:space:]]|$))'
      AND NOT EXISTS (
        SELECT 1 FROM public.pixel_fermate_fonti ff
        WHERE ff.fermata_id = f.id AND ff.stato_verifica = 'non_ammessa'
      )
    ORDER BY ST_Distance(f.posizione::geography, r.posizione), f.id
    LIMIT $5::integer
  `, [id, Number(punto.lon), Number(punto.lat), scadenzaMinima, limite]);

  return rows.map(normalizzaFermata);
}