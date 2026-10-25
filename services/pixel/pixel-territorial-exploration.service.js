// services/pixel/pixel-territorial-exploration.service.js
// PIXEL V5.5: generazione diagnostica di centri territoriali; solo SELECT, nessuna API Google.
import { pool } from '../../db/db.js';

const SQL = `
WITH comune AS (
  SELECT c.codice_istat_comune, c.nome_comune,
         ST_Transform(c.geom, 32632) AS geom_utm,
         ST_Area(c.geom::geography) / 1000000.0 AS area_geography_km2
  FROM public.pixel_confini_comunali c
  WHERE c.codice_istat_comune = $1
), nodi AS (
  SELECT n.id, n.posizione::geometry AS posizione
  FROM public.nodi_territoriali n
  WHERE n.codice_istat_comune = $1 AND n.attivo = TRUE
), fermate AS (
  SELECT f.id, f.posizione::geometry AS posizione
  FROM public.pixel_fermate f
  JOIN public.nodi_territoriali n ON n.id = f.nodo_territoriale_id
  WHERE n.codice_istat_comune = $1
), celle AS (
  SELECT c.codice_istat_comune, c.nome_comune, c.area_geography_km2,
         ST_Intersection(g.geom, c.geom_utm) AS porzione,
         ST_Area(ST_Intersection(g.geom, c.geom_utm)) AS area_m2
  FROM comune c
  CROSS JOIN LATERAL ST_SquareGrid($2::float8, c.geom_utm) AS g
  WHERE ST_Intersects(g.geom, c.geom_utm)
), centri AS (
  SELECT *, ST_Transform(ST_PointOnSurface(porzione), 4326) AS punto
  FROM celle WHERE area_m2 > 0
)
SELECT x.codice_istat_comune, x.nome_comune, x.area_geography_km2,
       x.area_m2 / 1000000.0 AS area_cella_km2,
       x.area_m2 / ($2::float8 * $2::float8) AS frazione_cella,
       ST_Y(x.punto) AS lat, ST_X(x.punto) AS lon,
       (SELECT MIN(ST_Distance(x.punto::geography, n.posizione::geography)) FROM nodi n) AS distanza_nodo_m,
       (SELECT MIN(ST_Distance(x.punto::geography, f.posizione::geography)) FROM fermate f) AS distanza_fermata_m,
       (SELECT COUNT(*) FROM fermate f WHERE ST_DWithin(x.punto::geography, f.posizione::geography, $3::float8)) AS fermate_vicine,
       (SELECT COUNT(*) FROM nodi) AS nodi_attivi
FROM centri x
ORDER BY x.area_m2 DESC, ST_Y(x.punto), ST_X(x.punto)`;

export async function generatePixelTerritorialCenters(codiceIstat, {
  database = pool,
  gridStepMeters = 3000,
  nearStopMeters = 500,
} = {}) {
  const codice = String(codiceIstat);
  if (!/^\d{6}$/.test(codice)) throw new Error('Codice ISTAT non valido');
  if (!Number.isSafeInteger(gridStepMeters) || gridStepMeters < 500 || gridStepMeters > 10000)
    throw new Error('gridStepMeters deve essere un intero tra 500 e 10000');
  if (!Number.isFinite(nearStopMeters) || nearStopMeters < 0 || nearStopMeters > 50000)
    throw new Error('nearStopMeters non valido');
  const { rows } = await database.query(SQL, [codice, gridStepMeters, nearStopMeters]);
  if (!rows.length) throw new Error(`Nessun centro generato per il comune ${codice}: verificare il confine ISTAT`);
  const centri = rows.map((r, i) => ({
    id_virtuale: `${codice}:grid:${i + 1}`,
    lat: Number(r.lat), lon: Number(r.lon),
    area_cella_km2: Number(Number(r.area_cella_km2).toFixed(4)),
    frazione_cella: Number(Number(r.frazione_cella).toFixed(5)),
    distanza_nodo_m: r.distanza_nodo_m == null ? null : Math.round(Number(r.distanza_nodo_m)),
    distanza_fermata_m: r.distanza_fermata_m == null ? null : Math.round(Number(r.distanza_fermata_m)),
    fermate_vicine: Number(r.fermate_vicine),
  }));
  return {
    comune: codice, nome_comune: rows[0].nome_comune,
    superficie_amministrativa_km2: Number(Number(rows[0].area_geography_km2).toFixed(3)),
    griglia_m: gridStepMeters, nodi_attivi: Number(rows[0].nodi_attivi),
    centri_totali: centri.length,
    area_celle_utm_km2: Number(centri.reduce((a, c) => a + c.area_cella_km2, 0).toFixed(3)),
    centri, avvertenza: 'Centri teorici, non prioritizzati per urbanizzazione o domanda. Nessuna scrittura DB o chiamata Google.',
  };
}
