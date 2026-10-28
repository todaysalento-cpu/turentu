import { Router } from 'express';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { pool } from '../db/db.js';
import { sendPasswordResetCode } from '../services/auth/gmail.service.js';

const router = Router();
const GENERIC = { message: 'Se l’indirizzo è registrato, riceverai un codice di recupero.' };
const CODE_TTL_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const EMAIL_LIMIT = 3;
const IP_LIMIT = 10;

function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email.length <= 150 && /^[^\s@\r\n]+@[^\s@\r\n]+\.[^\s@\r\n]+$/.test(email) ? email : null;
}

function secret() {
  if (!process.env.PASSWORD_RESET_SECRET || process.env.PASSWORD_RESET_SECRET.length < 32) {
    throw new Error('PASSWORD_RESET_SECRET mancante o troppo breve (minimo 32 caratteri)');
  }
  return process.env.PASSWORD_RESET_SECRET;
}

function digest(value) {
  return crypto.createHmac('sha256', secret()).update(value).digest('hex');
}

async function checkLimit(client, key, limit) {
  const result = await client.query(`
    INSERT INTO password_reset_rate_limits (rate_key, window_start, request_count)
    VALUES ($1, NOW(), 1)
    ON CONFLICT (rate_key) DO UPDATE SET
      window_start = CASE
        WHEN password_reset_rate_limits.window_start < NOW() - INTERVAL '1 hour'
        THEN NOW() ELSE password_reset_rate_limits.window_start END,
      request_count = CASE
        WHEN password_reset_rate_limits.window_start < NOW() - INTERVAL '1 hour'
        THEN 1 ELSE password_reset_rate_limits.request_count + 1 END
    RETURNING request_count
  `, [key]);
  return result.rows[0].request_count <= limit;
}

router.post('/forgot-password', async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  if (!email) return res.status(400).json({ message: 'Email non valida' });
  let client;
  try {
    secret();
    client = await pool.connect();
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const ipKey = `ip:${digest(ip).slice(0, 60)}`;
    const emailKey = `email:${digest(email).slice(0, 60)}`;
    // Atomic, database-backed limits shared across Render instances.
    const ipAllowed = await checkLimit(client, ipKey, IP_LIMIT);
    const emailAllowed = await checkLimit(client, emailKey, EMAIL_LIMIT);
    if (!ipAllowed || !emailAllowed) return res.status(200).json(GENERIC);

    const user = await client.query('SELECT id, email FROM utente WHERE LOWER(email) = $1 LIMIT 1', [email]);
    if (!user.rows.length) return res.status(200).json(GENERIC);

    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const codeHash = digest(`${user.rows[0].id}:${code}`);
    await client.query(`
      INSERT INTO password_reset_codes (user_id, code_hash, expires_at, attempts, created_at)
      VALUES ($1, $2, NOW() + INTERVAL '10 minutes', 0, NOW())
      ON CONFLICT (user_id) DO UPDATE SET
        code_hash = EXCLUDED.code_hash,
        expires_at = EXCLUDED.expires_at,
        attempts = 0,
        created_at = NOW()
    `, [user.rows[0].id, codeHash]);

    try {
      await sendPasswordResetCode(user.rows[0].email, code);
    } catch (error) {
      console.error('[PASSWORD RESET] Invio Gmail fallito:', error.response?.status || error.code || 'send_failed');
      // Remove only the code associated with this send attempt.
      await client.query('DELETE FROM password_reset_codes WHERE user_id = $1 AND code_hash = $2', [user.rows[0].id, codeHash]);
    }
    return res.status(200).json(GENERIC);
  } catch (error) {
    console.error('[PASSWORD RESET] Richiesta fallita:', error.message);
    return res.status(503).json({ message: 'Servizio temporaneamente non disponibile' });
  } finally {
    if (client) client.release();
  }
});

router.post('/reset-password', async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const code = req.body?.code;
  const password = req.body?.newPassword;
  if (!email || typeof code !== 'string' || !/^\d{6}$/.test(code) ||
      typeof password !== 'string' || password.length < 10 || password.length > 128) {
    return res.status(400).json({ message: 'Email, codice o password non validi (password: 10-128 caratteri)' });
  }
  let client;
  try {
    secret();
    client = await pool.connect();
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const allowed = await checkLimit(client, `verify:${digest(ip).slice(0, 56)}`, 30);
    if (!allowed) return res.status(429).json({ message: 'Troppi tentativi. Riprova più tardi.' });

    await client.query('BEGIN');
    const result = await client.query(`
      SELECT u.id, p.code_hash, p.expires_at, p.attempts
      FROM utente u JOIN password_reset_codes p ON p.user_id = u.id
      WHERE LOWER(u.email) = $1 FOR UPDATE OF p
    `, [email]);
    const record = result.rows[0];
    if (!record || record.attempts >= MAX_ATTEMPTS || new Date(record.expires_at).getTime() <= Date.now()) {
      await client.query('COMMIT');
      return res.status(400).json({ message: 'Codice non valido o scaduto' });
    }
    const suppliedHash = digest(`${record.id}:${code}`);
    const ok = crypto.timingSafeEqual(Buffer.from(suppliedHash, 'hex'), Buffer.from(record.code_hash, 'hex'));
    if (!ok) {
      await client.query('UPDATE password_reset_codes SET attempts = attempts + 1 WHERE user_id = $1', [record.id]);
      await client.query('COMMIT');
      return res.status(400).json({ message: 'Codice non valido o scaduto' });
    }
    const hashed = await bcrypt.hash(password, 10);
    await client.query('UPDATE utente SET password = $1 WHERE id = $2', [hashed, record.id]);
    await client.query('DELETE FROM password_reset_codes WHERE user_id = $1', [record.id]);
    await client.query('COMMIT');
    return res.json({ ok: true, message: 'Password aggiornata. Ora puoi accedere.' });
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('[PASSWORD RESET] Conferma fallita:', error.message);
    return res.status(503).json({ message: 'Servizio temporaneamente non disponibile' });
  } finally {
    if (client) client.release();
  }
});

export default router;
