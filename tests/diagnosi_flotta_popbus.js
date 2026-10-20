
import { pool } from '../db/db.js';

try {
  const sql = `
    SELECT
      v.id,
      v.driver_id,
      v.modello,
      v.posti_totali,
      v.stato,
      t.euro_km,
      dv.start,
      dv.fine,
      ST_Y(COALESCE(dv.coord, v.coord)::geometry) AS lat,
      ST_X(COALESCE(dv.coord, v.coord)::geometry) AS lon
    FROM veicolo v
    JOIN disponibilita_veicolo dv
      ON dv.veicolo_id = v.id
    JOIN LATERAL (
      SELECT MIN(euro_km) AS euro_km
      FROM tariffe
      WHERE veicolo_id = v.id
        AND tipo = 'standard'
        AND euro_km > 0
    ) t ON t.euro_km IS NOT NULL
    WHERE v.driver_id IS NOT NULL
      AND v.posti_totali > 0
      AND COALESCE(dv.coord, v.coord) IS NOT NULL
    ORDER BY t.euro_km, v.id
  `;

  const { rows } = await pool.query(sql);

  console.log('VEICOLI CANDIDATI POPBUS:', rows.length);
  console.table(rows);
} catch (error) {
  console.error('ERRORE DIAGNOSI:', error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
