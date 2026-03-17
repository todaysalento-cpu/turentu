import { pool } from '../../db/db.js';

/**
 * Crea pending a partire da slot selezionati
 * @param {Object} params - Parametri per i pending
 * @param {number} params.clienteId
 * @param {Array} params.slots - Array di slot { veicolo_id, start }
 * @param {string|interval} params.durata
 * @param {number} params.posti_richiesti
 * @param {string} params.tipo_corsa
 * @param {number} params.prezzo - Prezzo della corsa
 * @returns {Array} pending creati
 */
export async function createPendingFromSlot({ clienteId, slots, durata, posti_richiesti, tipo_corsa, prezzo = 0 }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const pendingRes = [];
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 15 * 60 * 1000); // 15 minuti da ora

    for (const slot of slots) {
      const res = await client.query(
        `INSERT INTO pending 
          (veicolo_id, cliente_id, start_datetime, durata, posti_richiesti, tipo_corsa, expires_at, stato, prezzo)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8)
         RETURNING *`,
        [slot.veicolo_id, clienteId, slot.start, durata, posti_richiesti, tipo_corsa, expiresAt, prezzo]
      );
      pendingRes.push(res.rows[0]);
    }

    await client.query('COMMIT');
    return pendingRes;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Cleanup dei pending scaduti
 */
export async function cleanupExpiredPending() {
  const client = await pool.connect();
  try {
    await client.query(
      `DELETE FROM pending WHERE expires_at < NOW() AND stato='pending'`
    );
  } finally {
    client.release();
  }
}

/**
 * Recupera un pending per ID
 * @param {number} pendingId
 * @param {Object} [client] - opzionale per transazione
 * @returns {Object|null} pending trovato
 */
export async function getPendingById(pendingId, client = null) {
  const conn = client || await pool.connect();
  try {
    const res = await conn.query(
      `SELECT * FROM pending WHERE id=$1`,
      [pendingId]
    );
    return res.rows[0] || null;
  } finally {
    if (!client) conn.release();
  }
}

/**
 * Aggiorna lo stato di un pending
 * @param {number} pendingId
 * @param {string} stato - nuovo stato
 * @param {Object} client - connessione opzionale per transazione
 */
export async function updatePendingStatus(pendingId, stato, client) {
  const conn = client || await pool.connect();
  try {
    await conn.query(
      `UPDATE pending SET stato=$1 WHERE id=$2`,
      [stato, pendingId]
    );
  } finally {
    if (!client) conn.release();
  }
}
