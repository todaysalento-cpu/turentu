/**
 * TURENTU_STREET_SEARCH_V1
 *
 * Ricerca stradale OSM per contesto cartografico.
 * Non genera punti di prelievo.
 * Non certifica civici o accessibilita veicolare.
 */

export const VERSIONE_STREET_SEARCH =
  'TURENTU_STREET_SEARCH_V1';

export const VERSIONE_MOTORE_STREET_SEARCH =
  'TURENTU_STREET_SEARCH_V1_5';

const MAX_GEOMETRIA_BYTES = 256 * 1024;

const MAX_GRUPPI = 3;
const MAX_DISTANZA_GRUPPI_M = 50;
const MAX_DIAGONALE_M = 5000;

const HIGHWAY_AMMESSI = [
  'motorway', 'motorway_link',
  'trunk', 'trunk_link',
  'primary', 'primary_link',
  'secondary', 'secondary_link',
  'tertiary', 'tertiary_link',
  'residential', 'unclassified',
  'living_street', 'service',
  'track', 'pedestrian',
  'footway', 'path', 'steps',
  'cycleway', 'bridleway',
  'road', 'minor'
];

const ALIAS_AMMESSI = [
  'official_name',
  'alt_name',
  'short_name',
  'loc_name',
  'name:it'
];

export function normalizzaNomeStrada(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function esito(stato, extra = {}) {
  return {
    stato,
    versione: VERSIONE_STREET_SEARCH,
    versioneMotore: VERSIONE_MOTORE_STREET_SEARCH,
    bounds: null,
    puntoPrelievo: null,
    ...extra
  };
}

export async function cercaStradaOsm(
  db,
  {
    codiceIstatComune,
    indirizzo,
    civico,
    localitaGid = null
  }
) {
  const codice = String(
    codiceIstatComune ?? ''
  ).trim();

  if (!/^\d{6}$/.test(codice)) {
    return esito('COMUNE_NON_VALIDO');
  }

  if (
    localitaGid !== null &&
    (
      !Number.isSafeInteger(Number(localitaGid)) ||
      Number(localitaGid) <= 0
    )
  ) {
    return esito('LOCALITA_NON_VALIDA');
  }

  const originale = normalizzaNomeStrada(indirizzo);

  if (!originale || originale.length > 250) {
    return esito('STRADA_NON_VALIDA');
  }

  const nomi = [originale];

  // Conserva la denominazione completa come prima
  // scelta: alcuni nomi stradali terminano con numeri.
  if (civico) {
    const suffisso = ' ' + normalizzaNomeStrada(civico);

    if (originale.endsWith(suffisso)) {
      const senzaCivico = originale
        .slice(0, -suffisso.length)
        .trim();

      if (senzaCivico) {
        nomi.push(senzaCivico);
      }
    }
  }

  for (const nome of [...new Set(nomi)]) {

    const { rows } = await db.query(`
      WITH territorio AS MATERIALIZED (
        SELECT l.geom
        FROM public.localita_istat_2021 l
        JOIN public.pixel_confini_comunali c
          ON c.codice_istat_comune =
             l.codice_istat_comune
        WHERE l.gid = $5::integer
          AND l.codice_istat_comune = $1
          AND ST_SRID(l.geom) = 4326
          AND ST_IsValid(l.geom)
          AND NOT ST_IsEmpty(l.geom)
          AND ST_CoveredBy(l.geom, c.geom)
      ),
      candidati AS MATERIALIZED (
        SELECT s.*, 1 AS priorita
        FROM public.territorial_osm_strade_attive s
        WHERE s.codice_istat_comune = $1
          AND s.nome_normalizzato = $2
          AND s.highway = ANY($3::text[])

        UNION ALL

        SELECT s.*, 2 AS priorita
        FROM public.territorial_osm_strade_attive s
        WHERE s.codice_istat_comune = $1
          AND s.highway = ANY($3::text[])
          AND EXISTS (
            SELECT 1
            FROM public.territorial_osm_strade_alias_attivi a
            WHERE a.importazione_id = s.importazione_id
              AND a.strada_id = s.id
              AND a.alias_normalizzato = $2
              AND a.fonte = ANY($4::text[])
          )
      ),
      ritagliati AS MATERIALIZED (
        SELECT
          s.id,
          s.nome,
          s.nome_normalizzato,
          s.comune,
          s.priorita,
          s.highway,
          CASE
            WHEN $5::integer IS NULL
              THEN s.geom
            ELSE ST_CollectionExtract(
              ST_Intersection(s.geom, t.geom),
              2
            )
          END AS geom
        FROM candidati s
        LEFT JOIN territorio t ON TRUE
        WHERE $5::integer IS NULL
           OR (
             t.geom IS NOT NULL
             AND ST_Intersects(s.geom, t.geom)
           )
      ),
      validi AS MATERIALIZED (
        SELECT *
        FROM ritagliati
        WHERE geom IS NOT NULL
          AND NOT ST_IsEmpty(geom)
          AND ST_Length(geom) > 0
      ),
      denominazioni AS MATERIALIZED (
        SELECT
          nome_normalizzato,
          MIN(priorita) AS priorita,
          COUNT(DISTINCT id)::integer
            AS segmenti_corrispondenti
        FROM validi
        WHERE priorita = (
          SELECT MIN(priorita)
          FROM validi
        )
        GROUP BY nome_normalizzato
      ),
      espansi AS MATERIALIZED (
        SELECT
          s.id,
          s.nome,
          s.nome_normalizzato,
          s.comune,
          n.priorita,
          n.segmenti_corrispondenti,
          s.highway,
          CASE
            WHEN $5::integer IS NULL
              THEN s.geom
            ELSE ST_CollectionExtract(
              ST_Intersection(s.geom, t.geom),
              2
            )
          END AS geom
        FROM denominazioni n
        JOIN public.territorial_osm_strade_attive s
          ON s.nome_normalizzato =
             n.nome_normalizzato
         AND s.codice_istat_comune = $1
         AND s.highway = ANY($3::text[])
        LEFT JOIN territorio t ON TRUE
        WHERE (
          SELECT COUNT(*)
          FROM denominazioni
        ) = 1
          AND (
            $5::integer IS NULL
            OR (
              t.geom IS NOT NULL
              AND ST_Intersects(s.geom, t.geom)
            )
          )
      ),
      migliori AS MATERIALIZED (
        SELECT
          v.*,
          d.geom AS componente
        FROM espansi v
        CROSS JOIN LATERAL ST_Dump(v.geom) d
        WHERE v.geom IS NOT NULL
          AND NOT ST_IsEmpty(v.geom)
          AND ST_Length(v.geom) > 0
      ),
      aggregati AS (
        SELECT
          nome_normalizzato,
          MIN(nome) AS nome,
          MIN(comune) AS comune,
          MIN(priorita) AS priorita,
          COUNT(DISTINCT id)::integer AS segmenti,
          MAX(segmenti_corrispondenti)
            AS segmenti_corrispondenti,
          ST_Extent(geom) AS estensione,

          ST_AsGeoJSON(
            ST_Multi(
              ST_CollectionExtract(
                ST_Collect(componente),
                2
              )
            ),
            15,
            0
          ) AS geometria_geojson,
          ST_ClusterIntersecting(componente) AS gruppi,
          ARRAY_AGG(DISTINCT highway) AS highway
        FROM migliori
        GROUP BY nome_normalizzato
      )
      SELECT
        nome,
        comune,
        priorita,
        segmenti,
        highway,
        segmenti_corrispondenti,

        CASE
          WHEN octet_length(geometria_geojson)
               <= 262144
          THEN geometria_geojson
          ELSE NULL
        END AS geometria_geojson,

        octet_length(geometria_geojson)
          AS geometria_bytes,
        cardinality(gruppi) AS gruppi,

        CASE
          WHEN cardinality(gruppi) BETWEEN 2 AND 3
          THEN (
            SELECT MAX(
              ST_Distance(
                ST_CollectionExtract(a.geom, 2)::geography,
                ST_CollectionExtract(b.geom, 2)::geography
              )
            )
            FROM unnest(gruppi)
              WITH ORDINALITY a(geom, i)
            JOIN unnest(gruppi)
              WITH ORDINALITY b(geom, i)
              ON a.i < b.i
          )
          ELSE NULL
        END AS distanza_max_m,

        ST_Distance(
          ST_SetSRID(
            ST_MakePoint(
              ST_XMin(estensione),
              ST_YMin(estensione)
            ), 4326
          )::geography,
          ST_SetSRID(
            ST_MakePoint(
              ST_XMax(estensione),
              ST_YMax(estensione)
            ), 4326
          )::geography
        ) AS diagonale_m,
        ST_YMin(estensione) AS sud,
        ST_XMin(estensione) AS ovest,
        ST_YMax(estensione) AS nord,
        ST_XMax(estensione) AS est
      FROM aggregati

      UNION ALL

      SELECT
        NULL AS nome,
        NULL AS comune,
        NULL AS priorita,
        NULL AS segmenti,
        NULL AS highway,
        NULL AS segmenti_corrispondenti,
        NULL AS geometria_geojson,
        NULL AS geometria_bytes,
        NULL AS gruppi,
        NULL AS distanza_max_m,
        NULL AS diagonale_m,
        NULL AS sud,
        NULL AS ovest,
        NULL AS nord,
        NULL AS est
      FROM denominazioni
      WHERE (
        SELECT COUNT(*)
        FROM denominazioni
      ) > 1
    `, [
      codice,
      nome,
      HIGHWAY_AMMESSI,
      ALIAS_AMMESSI,
      localitaGid
    ]);

    if (!rows.length) continue;

    if (rows.length !== 1) {
      return esito('STRADA_AMBIGUA');
    }

    const r = rows[0];

    if (!r.nome) {
      return esito('STRADA_AMBIGUA');
    }

    // V1.3: aggregazione esclusivamente cartografica.
    // Non implica continuita o percorribilita stradale.

    const gruppi = Number(r.gruppi);

    const distanzaMaxM =
      r.distanza_max_m == null
        ? null
        : Number(r.distanza_max_m);

    const diagonaleM =
      r.diagonale_m == null
        ? null
        : Number(r.diagonale_m);

    const multisegmento = gruppi > 1;

    const multisegmentoValido =
      Number.isInteger(gruppi) &&
      gruppi >= 2 &&
      gruppi <= MAX_GRUPPI &&
      Number.isFinite(distanzaMaxM) &&
      distanzaMaxM >= 0 &&
      distanzaMaxM <= MAX_DISTANZA_GRUPPI_M &&
      Number.isFinite(diagonaleM) &&
      diagonaleM >= 0 &&
      diagonaleM <= MAX_DIAGONALE_M;

    if (gruppi !== 1 && !multisegmentoValido) {
      return esito('STRADA_DISCONNESSA', {
        strada: r.nome,
        segmenti: Number(r.segmenti),
        gruppi,
        distanzaMassimaGruppiM: distanzaMaxM,
        diagonaleM
      });
    }

    const valori = [
      r.sud, r.ovest, r.nord, r.est
    ];

    if (valori.some(
      v => v == null || !Number.isFinite(Number(v))
    )) {
      return esito('BOUNDS_NON_VALIDI');
    }

    let [sud, ovest, nord, est] =
      valori.map(Number);

    if (
      sud < -90 || nord > 90 ||
      ovest < -180 || est > 180 ||
      sud > nord || ovest > est
    ) {
      return esito('BOUNDS_NON_VALIDI');
    }

    // Evita bounds degeneri per strade
    // perfettamente orizzontali o verticali.
    if (sud === nord) {
      sud = Math.max(-90, sud - 0.00005);
      nord = Math.min(90, nord + 0.00005);
    }

    if (ovest === est) {
      ovest = Math.max(-180, ovest - 0.00005);
      est = Math.min(180, est + 0.00005);
    }

    let geometriaStrada = null;

    const geometriaBytes =
      Number(r.geometria_bytes ?? 0);

    let statoGeometria =
      geometriaBytes > MAX_GEOMETRIA_BYTES
        ? 'LIMITE_DIMENSIONE'
        : 'NON_DISPONIBILE';

    if (
      typeof r.geometria_geojson === 'string' &&
      geometriaBytes <= MAX_GEOMETRIA_BYTES
    ) {
      try {
        const g = JSON.parse(
          r.geometria_geojson
        );

        const valida =
          g.type === 'MultiLineString' &&
          Array.isArray(g.coordinates) &&
          g.coordinates.length > 0 &&
          g.coordinates.every(linea =>
            Array.isArray(linea) &&
            linea.length >= 2 &&
            linea.every(punto =>
              Array.isArray(punto) &&
              punto.length === 2 &&
              Number.isFinite(punto[0]) &&
              Number.isFinite(punto[1]) &&
              punto[0] >= -180 &&
              punto[0] <= 180 &&
              punto[1] >= -90 &&
              punto[1] <= 90
            )
          );

        if (valida) {
          geometriaStrada = g;
          statoGeometria = 'DISPONIBILE';
        } else {
          statoGeometria = 'NON_VALIDA';
        }
      } catch {
        statoGeometria = 'NON_VALIDA';
      }
    }

    return esito('STRADA_RICONOSCIUTA', {
      fonte: 'OSM_STREET_INDEX',
      attribuzione: 'OpenStreetMap contributors',
      precisioneContesto: multisegmento
        ? 'STRADA_MULTISEGMENTO'
        : 'STRADA',

      gruppi,

      continuitaGeometrica: !multisegmento,

      distanzaMassimaGruppiM: multisegmento
        ? Math.round(distanzaMaxM * 1000) / 1000
        : 0,

      diagonaleM:
        Math.round(diagonaleM * 1000) / 1000,
      codiceIstatComune: codice,
      comune: r.comune,
      strada: r.nome,
      civicoRichiesto:
        nome === originale ? null : civico ?? null,
      civicoVerificato: false,
      corrispondenza:
        Number(r.priorita) === 1
          ? 'NOME_ESATTO'
          : 'ALIAS_ESATTO',
      segmenti: Number(r.segmenti),
      segmentiCorrispondenti:
        Number(r.segmenti_corrispondenti),

      aliasEspanso:
        Number(r.priorita) === 2 &&
        Number(r.segmenti) >
          Number(r.segmenti_corrispondenti),

      geometriaStrada,
      statoGeometria,
      geometriaBytes,

      highway: r.highway,
      uso: 'SOLO_CONTESTO_CARTOGRAFICO',
      bounds: [
        [sud, ovest],
        [nord, est]
      ]
    });
  }

  return esito('STRADA_NON_TROVATA');
}