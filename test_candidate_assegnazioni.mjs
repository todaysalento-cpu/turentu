import { pool } from './db/db.js';

try {
  const { rows } = await pool.query(`
    SELECT
      c.id,
      c.veicolo_id,
      v.driver_id AS operatore_id,
      c.tipo_corsa,
      c.stato,
      c.start_datetime,
      c.inizio_ciclo_operativo,
      c.fine_ciclo_operativo
    FROM corse c
    JOIN veicolo v ON v.id = c.veicolo_id
    WHERE c.start_datetime > NOW()
    ORDER BY c.start_datetime
    LIMIT 20
  `);

  console.table(rows);
} catch (err) {
  console.error('TEST FALLITO:', err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
