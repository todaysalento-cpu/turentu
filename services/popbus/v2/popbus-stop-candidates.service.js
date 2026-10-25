
 // services/popbus/v2/popbus-stop-candidates.service.js
 // PIXEL -> POPBUS V2: selezione fermate candidate.
 // Verifica/certificazione non obbligatoria nella fase provvisoria.
 // Sola lettura: nessuna attivazione e nessuna scrittura DB.

const DEFAULT_RADIUS_METERS = 1500;
const DEFAULT_LIMIT = 5;

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

  const { rows } = await client.query(
    `
    WITH richieste AS (
      SELECT id, origine, destinazione
      FROM public.richieste_pop_bus
      WHERE id = ANY($1::bigint[])
    ),
    punti AS (
      SELECT id AS richiesta_id, 'salita'::text AS tipo,
             origine AS posizione
      FROM richieste

      UNION ALL

      SELECT id AS richiesta_id, 'discesa'::text AS tipo,
             destinazione AS posizione
      FROM richieste
    ),
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
    `,
    [ids, raggioMetri, limite]
  );

  const risultato = new Map(
    ids.map(id => [
      id,
      {
        richiesta_id: id,
        salita: [],
        discesa: []
      }
    ])
  );

  for (const row of rows) {
    const item = risultato.get(Number(row.richiesta_id));
    if (!item) continue;

    item[row.tipo].push({
      fermata_id: Number(row.fermata_id),
      nome: row.nome,
      nodo_territoriale_id: Number(row.nodo_territoriale_id),
      lat: Number(row.lat),
      lon: Number(row.lon),
      distanza_metri: Number(row.distanza_metri),
      verificata: row.verificata === true,
      tipi_veicolo_ammessi: row.tipi_veicolo_ammessi
    });
  }

  return [...risultato.values()].map(item => ({
    ...item,
    completa: item.salita.length > 0 && item.discesa.length > 0
  }));
}
