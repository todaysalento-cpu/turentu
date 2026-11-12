import { pool } from '../../db/db.js';
import { sendPush } from './push.service.js';
import { sendNotification } from '../../socket.js';

// Mantenuto per le notifiche esistenti che usano il timestamp applicativo.
const getRomeISOString = () => {
  const d = new Date();
  return new Date(d.toLocaleString('en-US', { timeZone: 'Europe/Rome' })).toISOString();
};

export async function deliverNotification(notification, { role, title = 'Nuova Notifica', data = {} }) {
  const { id, user_id: userId, type, message } = notification;
  try {
    await sendNotification({ userId, role, notification });
  } catch (error) {
    console.warn('Consegna notifica socket:', error.message);
  }

  const { rows: [recipient] } = await pool.query(
    'SELECT push_token FROM utente_push_tokens WHERE user_id = $1 LIMIT 1',
    [userId],
  );
  if (!recipient?.push_token) return;

  try {
    await sendPush(recipient.push_token, title, message, {
      ...data, notificationId: String(id), type,
    });
  } catch (error) {
    console.error('Consegna notifica push:', error.message);
  }
}

export async function notifyUser(userId, { type, title, message, role, data }) {
  try {
    const { rows: [notification] } = await pool.query(`
      INSERT INTO notifications (user_id, type, message, seen, created_at)
      VALUES ($1, $2, $3, false, $4) RETURNING *
    `, [userId, type, message, getRomeISOString()]);
    await deliverNotification(notification, { role, title, data });
    return notification;
  } catch (error) {
    console.error('Salvataggio o consegna notifica:', error.message);
    throw error;
  }
}
