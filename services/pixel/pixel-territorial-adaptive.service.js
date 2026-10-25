// services/pixel/pixel-territorial-adaptive.service.js
// PIXEL V5.5.2: centri integrativi rigenerati sulle aree residue.
// Solo SELECT PostGIS, nessuna API Google, nessuna persistenza.
import { pool } from '../../db/db.js';

const SQL = `
WITH comune AS (
  SELECT codice_istat_comune, nome_comune, geom,
         ST_Transform(geom, 32632) AS utm
  FROM public.pixel_confini_comunali
  WHERE codice_istat_comune = $1
), celle AS (
  SELECT ST_Transform(
           ST_PointOnSurface(ST_Intersection(g.geom, c.utm)), 4326
         ) AS punto
  FROM comune c
  CROSS JOIN LATERAL ST_SquareGrid($2::float8, c.utm) AS g
  WHERE ST_Area(ST_Intersection(g.geom, c.utm)) > 0
), base AS (
  SELECT ST_UnaryUnion(ST_Collect(
           ST_Buffer(punto::geography, $3::float8)::geometry
         )) AS geom
  FROM celle
), punti_scelti AS (
  SELECT ST_SetSRID(ST_MakePoint(x.lon, x.lat), 4326) AS punto
  FROM jsonb_to_recordset($5::jsonb) AS x(lat float8, lon float8)
), aggiunti AS (
  SELECT ST_UnaryUnion(ST_Collect(
           ST_Buffer(punto::geography, $3::float8)::geometry
         )) AS geom
  FROM punti_scelti
), copertura AS (
  SELECT CASE WHEN a.geom IS NULL THEN b.geom
              ELSE ST_UnaryUnion(ST_Collect(b.geom, a.geom)) END AS geom
  FROM base b CROSS JOIN aggiunti a
), scoperto_residuo AS (
  SELECT ST_Difference(c.geom, p.geom) AS geom
  FROM comune c CROSS JOIN copertura p
), componenti AS (
  SELECT (ST_Dump(ST_CollectionExtract(s.geom, 3))).geom AS geom
  FROM scoperto_residuo s
), candidate AS (
  SELECT ROW_NUMBER() OVER (
           ORDER BY ST_Area(geom::geography) DESC,
                    ST_X(ST_PointOnSurface(geom)),
                    ST_Y(ST_PointOnSurface(geom))
         )::int AS id,
         ST_PointOnSurface(geom) AS punto,
         ST_Area(geom::geography) AS area_componente_m2
  FROM componenti
  WHERE ST_Area(geom::geography) >= $4::float8
), valutazioni AS (
  SELECT k.id, ST_Y(k.punto) AS lat, ST_X(k.punto) AS lon,
         k.area_componente_m2,
         ST_Area(ST_Intersection(
           ST_Buffer(k.punto::geography, $3::float8)::geometry,
           s.geom
         )::geography) AS guadagno_m2
  FROM candidate k
  CROSS JOIN scoperto_residuo s
  WHERE NOT EXISTS (
    SELECT 1 FROM punti_scelti p
    WHERE ST_DWithin(k.punto::geography, p.punto::geography, $6::float8)
  )
), misure AS (
  SELECT ST_Area(c.geom::geography) AS totale_m2,
         ST_Area(s.geom::geography) AS residuo_m2,
         ST_Area(ST_Intersection(c.geom, b.geom)::geography) AS coperto_base_m2
  FROM comune c CROSS JOIN scoperto_residuo s CROSS JOIN base b
)
SELECT (SELECT nome_comune FROM comune) AS nome_comune,
       (SELECT COUNT(*) FROM celle) AS centri_base,
       (SELECT COUNT(*) FROM candidate) AS candidate_totali,
       m.totale_m2, m.residuo_m2, m.coperto_base_m2,
       v.id, v.lat, v.lon, v.area_componente_m2, v.guadagno_m2
FROM misure m
LEFT JOIN LATERAL (
  SELECT * FROM valutazioni
  ORDER BY guadagno_m2 DESC, area_componente_m2 DESC, id ASC
  LIMIT 1
) v ON TRUE`;

export async function generatePixelAdaptiveCenters(codiceIstat, {
  database = pool,
  gridStepMeters = 3000,
  searchRadiusMeters = 1500,
  minComponentAreaM2 = 100000,
  maxAdditionalCenters = 30,
  targetCoveragePercent = 98,
  minMarginalGainM2 = 100000,
  minCenterDistanceMeters = 500,
} = {}) {
  const codice = String(codiceIstat);
  if (!/^\d{6}$/.test(codice)) throw new Error('Codice ISTAT non valido');
  const range = (v, name, min, max) => {
    if (!Number.isFinite(v) || v < min || v > max) {
      throw new Error(`${name} non valido`);
    }
  };
  range(gridStepMeters, 'gridStepMeters', 500, 10000);
  range(searchRadiusMeters, 'searchRadiusMeters', 100, 5000);
  range(minComponentAreaM2, 'minComponentAreaM2', 0, 100000000);
  range(minMarginalGainM2, 'minMarginalGainM2', 0, 100000000);
  range(minCenterDistanceMeters, 'minCenterDistanceMeters', 0, 10000);
  range(targetCoveragePercent, 'targetCoveragePercent', 0, 100);
  if (!Number.isSafeInteger(maxAdditionalCenters) ||
      maxAdditionalCenters < 0 || maxAdditionalCenters > 100) {
    throw new Error('maxAdditionalCenters non valido');
  }

  const scelti = [];
  let ultima;
  let motivo = 'limite_centri';
  let centriIntegrativiIniziali = 0;
  let queryEseguite = 0;

  // L'ultima interrogazione misura la copertura DOPO l'ultima scelta.
  for (let iter = 0; iter <= maxAdditionalCenters; iter++) {
    const { rows } = await database.query(SQL, [
      codice, gridStepMeters, searchRadiusMeters, minComponentAreaM2,
      JSON.stringify(scelti.map(({ lat, lon }) => ({ lat, lon }))),
      minCenterDistanceMeters,
    ]);
    queryEseguite++;
    if (!rows.length || rows[0].totale_m2 == null) {
      throw new Error(`Confine comunale non trovato: ${codice}`);
    }
    ultima = rows[0];
    if (iter === 0) centriIntegrativiIniziali = Number(ultima.candidate_totali);
    // La copertura e' misurata sul confine comunale, non sull'area dei buffer.
    const coperturaPct = (1 - Number(ultima.residuo_m2) / Number(ultima.totale_m2)) * 100;
    if (coperturaPct >= targetCoveragePercent - 1e-9) {
      motivo = 'copertura_obiettivo';
      break;
    }
    if (iter === maxAdditionalCenters) break;
    if (ultima.id == null) { motivo = 'nessun_candidato'; break; }
    const gain = Number(ultima.guadagno_m2);
    if (gain <= 0 || gain < minMarginalGainM2) {
      motivo = 'guadagno_insufficiente';
      break;
    }
    scelti.push({
      id_virtuale: `${codice}:adaptive:${scelti.length + 1}`,
      // L'id del candidato e' locale alla singola iterazione.
      id_candidato: Number(ultima.id),
      lat: Number(ultima.lat),
      lon: Number(ultima.lon),
      guadagno_km2: Number((gain / 1e6).toFixed(4)),
      area_componente_km2: Number((Number(ultima.area_componente_m2) / 1e6).toFixed(4)),
    });
  }

  const totale = Number(ultima.totale_m2);
  const residuo = Number(ultima.residuo_m2);
  const base = Number(ultima.coperto_base_m2);
  const round = x => Number(x.toFixed(3));
  return {
    comune: codice,
    nome_comune: ultima.nome_comune,
    griglia_m: gridStepMeters,
    raggio_ricerca_m: searchRadiusMeters,
    centri_base: Number(ultima.centri_base),
    centri_integrativi_teorici: centriIntegrativiIniziali,
    centri_aggiunti: scelti.length,
    copertura_obiettivo_percentuale: targetCoveragePercent,
    guadagno_marginale_minimo_km2: minMarginalGainM2 / 1e6,
    centri: scelti,
    superficie_comunale_km2: round(totale / 1e6),
    copertura_base_percentuale: round(base / totale * 100),
    copertura_finale_percentuale: round((totale - residuo) / totale * 100),
    superficie_recuperata_km2: round((totale - residuo - base) / 1e6),
    superficie_residua_km2: round(residuo / 1e6),
    motivo_arresto: motivo,
    diagnostica_adattiva: {
      candidate_iniziali: centriIntegrativiIniziali,
      candidate_residue_finali: Number(ultima.candidate_totali),
      query_eseguite: queryEseguite,
      distanza_minima_centri_m: minCenterDistanceMeters,
      generazione_dinamica: true,
    },
    avvertenza: 'Copertura geometrica teorica, non rilevanza per la mobilita. Solo SELECT, nessuna Google API.',
  };
}
