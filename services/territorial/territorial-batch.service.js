
import { randomUUID } from 'node:crypto';
import { pool } from '../../db/db.js';

const SCENARIO_KM = 15;
const MAX_BATCH = 5;
const LEASE_SECONDS = 120;

export async function acquisisciBatch(limit = MAX_BATCH) {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_BATCH) {
    throw new Error('Limite batch non valido');
  }

  const workerId = `territorial-${randomUUID()}`;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '3s'");
    await client.query("SET LOCAL statement_timeout = '15s'");

    const { rows } = await client.query(`
      WITH selezionate AS (
        SELECT id
        FROM territorial_hub_coda_stradale
        WHERE scenario_km = $1 AND stato = 'in_attesa'
        ORDER BY priorita, distanza_geografica_m, id
        LIMIT $2
        FOR UPDATE SKIP LOCKED
      )
      UPDATE territorial_hub_coda_stradale q
      SET stato = 'in_elaborazione',
          worker_id = $3,
          iniziato_at = NOW(),
          terminato_at = NULL,
          lease_expires_at = NOW() + ($4 * INTERVAL '1 second'),
          updated_at = NOW()
      FROM selezionate s
      WHERE q.id = s.id
      RETURNING q.id, q.centro_gid, q.hub_id, q.stato
    `, [SCENARIO_KM, limit, workerId, LEASE_SECONDS]);

    await client.query('COMMIT');
    return { workerId, righe: rows };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function rinnovaLease(workerId) {
  const { rowCount } = await pool.query(`
    UPDATE territorial_hub_coda_stradale
    SET lease_expires_at = NOW() + ($2 * INTERVAL '1 second'),
        updated_at = NOW()
    WHERE worker_id = $1
      AND stato = 'in_elaborazione'
      AND lease_expires_at > NOW()
  `, [workerId, LEASE_SECONDS]);

  return rowCount;
}

export async function rilasciaBatch(workerId) {
  const { rows } = await pool.query(`
    UPDATE territorial_hub_coda_stradale
    SET stato = 'in_attesa',
        worker_id = NULL,
        iniziato_at = NULL,
        terminato_at = NULL,
        lease_expires_at = NULL,
        updated_at = NOW()
    WHERE worker_id = $1
      AND stato = 'in_elaborazione'
    RETURNING id
  `, [workerId]);

  return rows;
}

export async function recuperaScaduti(limit = 100) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('Limite recupero non valido');
  }

  const { rows } = await pool.query(`
    WITH scadute AS (
      SELECT id
      FROM territorial_hub_coda_stradale
      WHERE stato = 'in_elaborazione'
        AND lease_expires_at < NOW()
      ORDER BY lease_expires_at, id
      LIMIT $1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE territorial_hub_coda_stradale q
    SET stato = 'in_attesa',
        worker_id = NULL,
        iniziato_at = NULL,
        terminato_at = NULL,
        lease_expires_at = NULL,
        updated_at = NOW()
    FROM scadute s
    WHERE q.id = s.id
    RETURNING q.id
  `, [limit]);

  return rows;
}
