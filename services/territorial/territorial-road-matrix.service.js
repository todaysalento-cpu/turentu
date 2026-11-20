
import { pool } from '../../db/db.js';

export async function previewTerritorialRoadMatrix(options = {}) {
  const scenarioKm = Number(options.scenarioKm ?? 15);
  const limit = Number(options.limit ?? 5);

  if (![5, 10, 15].includes(scenarioKm)) {
    throw new Error('Scenario non valido');
  }

  if (!Number.isInteger(limit) || limit < 1 || limit > 25) {
    throw new Error('Limite non valido: consentiti 1-25 elementi');
  }

  const sql = `
    SELECT
      q.id,
      q.centro_gid,
      q.hub_id,
      l.nome AS centro,
      h.nome AS hub,
      q.distanza_geografica_m,
      q.priorita,
      ST_Y(ST_PointOnSurface(l.geom::geometry)) AS centro_lat,
      ST_X(ST_PointOnSurface(l.geom::geometry)) AS centro_lon,
      ST_Y(h.posizione) AS hub_lat,
      ST_X(h.posizione) AS hub_lon
    FROM territorial_hub_coda_stradale q
    JOIN localita_istat_2021 l ON l.gid = q.centro_gid
    JOIN pixel_hub_candidati h ON h.id = q.hub_id
    WHERE q.scenario_km = $1
      AND q.stato = 'in_attesa'
    ORDER BY q.priorita, q.distanza_geografica_m, q.id
    LIMIT $2
  `;

  const { rows } = await pool.query(sql, [scenarioKm, limit]);

  return {
    modalita: 'dry_run',
    scenario_km: scenarioKm,
    elementi: rows.length,
    chiamate_google_eseguite: 0,
    scritture_database: 0,
    richieste: rows.map(row => ({
      ...row,
      coordinate_valide: [
        row.centro_lat,
        row.centro_lon,
        row.hub_lat,
        row.hub_lon,
      ].every(value => Number.isFinite(Number(value))),
    })),
  };
}
