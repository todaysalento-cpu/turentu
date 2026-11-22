import Stripe from 'stripe';
import { transitionArGroup } from '../booking/ar-coordinator.service.js';
import { pool } from '../../db/db.js';

/**
 * Crea pending a partire da slot selezionati
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
 * @returns {number} Numero di record eliminati
 */
export async function cleanupExpired() {
  const { rowCount } = await pool.query(
    `DELETE FROM pending WHERE expires_at < NOW() AND stato = 'pending'
      AND ar_vincolata IS NOT TRUE`
  );
  const { rows: groups } = await pool.query(`
    SELECT id FROM ar_gruppi
    WHERE expires_at <= now() AND andata_tipo = 'privata' AND ritorno_tipo = 'privata'
      AND stato IN ('in_autorizzazione', 'autorizzato', 'in_attesa', 'pronto', 'annullamento_richiesto')
    ORDER BY expires_at LIMIT 50
  `);
  for (const { id } of groups) {
    try { await scadiPrivataAR(id); }
    catch (error) { console.error('[PRIVATE AR EXPIRY]', id, error.code ?? error.name); }
  }
  return rowCount;
}

async function scadiPrivataAR(id) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [group] } = await client.query(`
      SELECT id, cliente_id, stato FROM ar_gruppi
      WHERE id = $1 AND expires_at <= now()
        AND andata_tipo = 'privata' AND ritorno_tipo = 'privata'
        AND stato IN ('in_autorizzazione', 'autorizzato', 'in_attesa', 'pronto', 'annullamento_richiesto')
      FOR UPDATE SKIP LOCKED
    `, [id]);
    if (group) {
      const { rows: legs } = await client.query(`
        SELECT ar_tratta, payment_intent_id FROM pending
        WHERE ar_group_id = $1 AND cliente_id = $2 AND ar_vincolata IS TRUE
        ORDER BY id FOR UPDATE
      `, [id, group.cliente_id]);
      if (legs.length !== 2 || !legs.some(leg => leg.ar_tratta === 'andata') ||
          !legs.some(leg => leg.ar_tratta === 'ritorno') ||
          legs.some(leg => !leg.payment_intent_id) ||
          legs[0].payment_intent_id === legs[1].payment_intent_id) {
        throw new Error('PRIVATE_AR_EXPIRY_LEGS_INVALID');
      }
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
      const intents = await Promise.all(legs.map(async leg => {
        const intent = await stripe.paymentIntents.retrieve(leg.payment_intent_id);
        if (intent.capture_method !== 'manual' || intent.metadata?.ar_group_id !== id ||
            intent.metadata?.ar_tratta !== leg.ar_tratta ||
            intent.metadata?.clienteId !== String(group.cliente_id) || intent.status === 'succeeded') {
          throw new Error('PRIVATE_AR_EXPIRY_PAYMENT_INVALID');
        }
        return intent;
      }));
      if (group.stato !== 'annullamento_richiesto') {
        await transitionArGroup(client, id, group.stato, 'annullamento_richiesto');
      }
      for (const intent of intents) {
        if (intent.status !== 'canceled') {
          await stripe.paymentIntents.cancel(intent.id, {}, {
            idempotencyKey: `turentu-private-ar-expiry-${intent.id}`
          });
        }
      }
      await client.query(`
        UPDATE pending SET stato = 'rifiutata'
        WHERE ar_group_id = $1 AND ar_vincolata IS TRUE AND stato = 'pending'
      `, [id]);
      await transitionArGroup(client, id, 'annullamento_richiesto', 'annullato');
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Recupera un pending per ID
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

/**
 * Conta i pending attivi per un cliente
 */
export async function countPendingByCliente(clienteId) {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `SELECT COUNT(*) FROM pending WHERE cliente_id=$1 AND stato='pending'`,
      [clienteId]
    );
    return parseInt(res.rows[0].count, 10);
  } finally {
    client.release();
  }
}

/**
 * Conta tutti i pending attivi (per admin)
 */
export async function countAllPending() {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `SELECT COUNT(*) FROM pending WHERE stato='pending'`
    );
    return parseInt(res.rows[0].count, 10);
  } finally {
    client.release();
  }
}