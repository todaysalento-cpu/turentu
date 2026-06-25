// ======================= routes/auth.routes.js =======================
import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { pool } from '../db/db.js';
import nodemailer from 'nodemailer';
import crypto from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import twilio from 'twilio';
import AppleAuth from 'apple-auth'; // Aggiunto per il supporto Apple

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'segreto-di-test';
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const twilioClient = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH_TOKEN);

// Configurazione Apple Auth
const apple = new AppleAuth({
  client_id: process.env.APPLE_CLIENT_ID,
  team_id: process.env.APPLE_TEAM_ID,
  key_id: process.env.APPLE_KEY_ID,
}, process.env.APPLE_PRIVATE_KEY?.replace(/\\n/g, '\n'));

// -------------------- Nodemailer --------------------
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT,
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// ===================== MIDDLEWARE AUTH =====================
const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : req.cookies?.token;

  if (!token) return res.status(401).json({ message: 'Non autenticato' });

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ message: 'Token non valido' });
  }
};

// ===================== COOKIE CONFIG =====================
const cookieOptions = {
  httpOnly: true,
  sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
  secure: process.env.NODE_ENV === 'production',
  path: '/',
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

// ===================== /me =====================
router.get('/me', (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : req.cookies?.token;

  if (!token) return res.status(401).json({ message: 'Non autenticato' });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    res.json({ ...payload, token });
  } catch (err) {
    console.error('❌ Token non valido:', err.message);
    return res.status(401).json({ message: 'Token non valido' });
  }
});

// ===================== ELIMINAZIONE ACCOUNT =====================
router.delete('/me/delete', authenticate, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); // Inizia transazione per sicurezza

    // 1. Elimina i dati associati all'utente (es. token push)
    await client.query('DELETE FROM utente_push_tokens WHERE user_id = $1', [req.user.id]);

    // 2. Elimina l'utente
    await client.query('DELETE FROM utente WHERE id = $1', [req.user.id]);

    await client.query('COMMIT'); // Conferma le modifiche
    
    res.clearCookie('token', { ...cookieOptions, maxAge: 0 });
    res.json({ message: 'Account eliminato con successo' });
  } catch (err) {
    await client.query('ROLLBACK'); // Annulla tutto in caso di errore
    console.error('❌ Errore eliminazione account:', err);
    res.status(500).json({ message: 'Errore durante l\'eliminazione' });
  } finally {
    client.release();
  }
});

// ===================== LOGIN =====================
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ message: 'Email e password richieste' });

  try {
    const result = await pool.query(
      'SELECT id, email, password, tipo, nome FROM utente WHERE email=$1',
      [email]
    );
    const user = result.rows[0];
    if (!user) return res.status(401).json({ message: 'Utente non trovato' });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ message: 'Password errata' });

    const payload = { id: user.id, role: user.tipo, email: user.email, nome: user.nome };
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });

    res.cookie('token', token, cookieOptions);
    res.json({ ...payload, token });
  } catch (err) {
    console.error('❌ Auth login error:', err);
    res.status(500).json({ message: 'Errore server' });
  }
});

// ===================== LOGOUT =====================
router.post('/logout', (req, res) => {
  res.clearCookie('token', { ...cookieOptions, maxAge: 0 });
  res.json({ message: 'Logout eseguito' });
});

// ===================== REGISTER =====================
router.post('/register', async (req, res) => {
  const { nome, email, password, tipo } = req.body;
  if (!nome || !email || !password) return res.status(400).json({ message: 'Nome, email e password richiesti' });

  const client = await pool.connect();
  try {
    const exists = await client.query('SELECT id FROM utente WHERE email=$1', [email]);
    if (exists.rows.length) return res.status(409).json({ message: 'Email già registrata' });

    const hashed = await bcrypt.hash(password, 10);
    const insert = await client.query(
      `INSERT INTO utente (nome, email, password, tipo)
       VALUES ($1, $2, $3, $4)
       RETURNING id, tipo, email, nome`,
      [nome, email, hashed, tipo || 'cliente']
    );

    const user = insert.rows[0];
    const token = jwt.sign({ id: user.id, role: user.tipo, email: user.email, nome: user.nome }, JWT_SECRET, { expiresIn: '7d' });

    res.cookie('token', token, cookieOptions);
    res.json({ ...user, token });
  } catch (err) {
    console.error('❌ Register error:', err);
    res.status(500).json({ message: 'Errore server' });
  } finally {
    client.release();
  }
});

// ===================== LOGIN GOOGLE =====================
router.post('/google', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ message: 'Token Google richiesto' });

  const client = await pool.connect();
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    const email = payload.email;
    const nome = payload.name;

    let userRes = await client.query('SELECT id, tipo, email, nome FROM utente WHERE email=$1', [email]);
    let user;

    if (userRes.rows.length) {
      user = userRes.rows[0];
    } else {
      const hashed = await bcrypt.hash(crypto.randomBytes(16).toString('hex'), 10);
      const insert = await client.query(
        `INSERT INTO utente (nome, email, password, tipo)
         VALUES ($1, $2, $3, $4) RETURNING id, tipo, email, nome`,
        [nome, email, hashed, 'cliente']
      );
      user = insert.rows[0];
    }

    const jwtToken = jwt.sign({ id: user.id, role: user.tipo, email: user.email, nome: user.nome }, JWT_SECRET, { expiresIn: '7d' });
    res.cookie('token', jwtToken, cookieOptions);
    res.json({ ...user, token: jwtToken });
  } catch (err) {
    console.error('❌ Google login error:', err);
    res.status(500).json({ message: 'Login Google fallito' });
  } finally {
    client.release();
  }
});

// ===================== LOGIN APPLE =====================
router.post('/apple', async (req, res) => {
  const { identityToken, fullName } = req.body;
  if (!identityToken) return res.status(400).json({ message: 'Token Apple richiesto' });

  const client = await pool.connect();
  try {
    const payload = await apple.verifyIdToken(identityToken);
    const appleId = payload.sub;
    const email = payload.email;

    let userRes = await client.query('SELECT id, tipo, email, nome FROM utente WHERE apple_id=$1 OR ($2 IS NOT NULL AND email=$2)', [appleId, email]);
    let user;

    if (userRes.rows.length > 0) {
      user = userRes.rows[0];
      if (!user.apple_id) {
        await client.query('UPDATE utente SET apple_id=$1 WHERE id=$2', [appleId, user.id]);
      }
    } else {
      const nome = fullName ? `${fullName.givenName || ''} ${fullName.familyName || ''}`.trim() : 'Utente Apple';
      const hashed = await bcrypt.hash(crypto.randomBytes(16).toString('hex'), 10);
      const insert = await client.query(
        `INSERT INTO utente (nome, email, apple_id, password, tipo)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, tipo, email, nome`,
        [nome, email, appleId, hashed, 'cliente']
      );
      user = insert.rows[0];
    }

    const jwtToken = jwt.sign({ id: user.id, role: user.tipo, email: user.email, nome: user.nome }, JWT_SECRET, { expiresIn: '7d' });
    res.cookie('token', jwtToken, cookieOptions);
    res.json({ ...user, token: jwtToken });
  } catch (err) {
    console.error('❌ Errore login Apple:', err);
    res.status(500).json({ message: 'Login Apple fallito' });
  } finally {
    client.release();
  }
});

// ===================== SAVE PUSH TOKEN =====================
router.post('/me/push-token', (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : req.cookies?.token;

  if (!token) return res.status(401).json({ message: 'Non autenticato' });

  let user;
  try {
    user = jwt.verify(token, JWT_SECRET);
  } catch (err) {
    console.error('❌ Token non valido:', err.message);
    return res.status(401).json({ message: 'Token non valido' });
  }

  const { push_token, device_type } = req.body;
  if (!push_token) return res.status(400).json({ message: 'push_token richiesto' });

  pool.query(`
    INSERT INTO utente_push_tokens (user_id, push_token, device_type)
    VALUES ($1, $2, $3)
    ON CONFLICT (user_id, push_token) DO NOTHING
  `, [user.id, push_token, device_type || 'unknown'])
    .then(() => res.json({ message: 'Token push salvato' }))
    .catch(err => {
      console.error('❌ Errore salvataggio push token:', err);
      res.status(500).json({ message: 'Errore server' });
    });
});

export { router };