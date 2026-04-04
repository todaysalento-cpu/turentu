// ======================= routes/auth.routes.js =======================
import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { pool } from '../db/db.js';
import nodemailer from 'nodemailer';
import crypto from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import twilio from 'twilio';

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'segreto-di-test';
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const twilioClient = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH_TOKEN);

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

// ===================== COOKIE CONFIG =====================
const cookieOptions = {
  httpOnly: true,
  sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
  secure: process.env.NODE_ENV === 'production',
  path: '/',
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

// ===================== /me =====================
// Ora legge sia cookie che header Authorization
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

export { router };