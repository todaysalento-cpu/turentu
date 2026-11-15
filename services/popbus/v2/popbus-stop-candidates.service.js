
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
      SELECT id, origine, destinazione, origine_fermata_id, destinazione_fermata_id
      FROM public.richieste_pop_bus
      WHERE id = ANY($1::bigint[])
    ),
    punti AS (
      SELECT id AS richiesta_id, 'salita'::text AS tipo,
             origine::geography AS posizione, origine_fermata_id AS fermata_fissata
      FROM richieste

      UNION ALL

      SELECT id AS richiesta_id, 'discesa'::text AS tipo,
             destinazione::geography AS posizione, destinazione_fermata_id AS fermata_fissata
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
  client, origine, destinazione, origineNodoId, destinazioneNodoId, raccolta
}) {
  const rows = await leggiFermateCandidate(client, `
    WITH punti AS (
      SELECT 1 AS richiesta_id, tipo,
             ST_SetSRID(ST_MakePoint(lon, lat), 4326)::geography AS posizione,
             NULL::bigint AS fermata_fissata
      FROM jsonb_to_recordset($1::jsonb) AS p(tipo text, lat float8, lon float8)
    )`, [JSON.stringify([
      ...(!raccolta ? [{ ...origine, tipo: 'salita' }] : []),
      { ...destinazione, tipo: 'discesa' }
    ]), DEFAULT_RADIUS_METERS, DEFAULT_LIMIT]);

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
        ST_Y(f.posizione::geometry) AS lat,
        ST_X(f.posizione::geometry) AS lon,
        ST_Distance(p.posizione, f.posizione) AS distanza_metri,

        ROW_NUMBER() OVER (
          PARTITION BY p.richiesta_id, p.tipo
          ORDER BY ST_Distance(p.posizione, f.posizione), f.id
        ) AS posizione_ordine

      FROM punti p

      JOIN public.pixel_fermate f
        ON f.attiva = TRUE
       AND (p.fermata_fissata IS NULL OR f.id = p.fermata_fissata)
       AND ST_DWithin(
         p.posizione,
         f.posizione,
         $2::double precision
       )

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

function normalizzaFermata(row) {
    return {
      fermata_id: Number(row.fermata_id),
      nome: row.nome,
      nodo_territoriale_id: Number(row.nodo_territoriale_id),
      lat: Number(row.lat),
      lon: Number(row.lon),
      distanza_metri: Number(row.distanza_metri),
      verificata: row.verificata === true,
      tipi_veicolo_ammessi: row.tipi_veicolo_ammessi
    };
}
