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
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  path: '/',
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

// ===================== LOGIN =====================
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ message: 'Email e password richieste' });

  try {
    const result = await pool.query(
      'SELECT id, email, password, tipo, nome FROM utente WHERE email=$1',
      [email]
    );
    const user = result.rows[0];
    if (!user) return res.status(401).json({ message: 'Utente non trovato' });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ message: 'Password errata' });

    const payload = {
      id: user.id,
      role: user.tipo,
      email: user.email,
      nome: user.nome
    };

    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });

    res.cookie('token', token, cookieOptions);
    res.json({ ...payload, token });
  } catch (err) {
    console.error('❌ Auth login error:', err);
    res.status(500).json({ message: 'Errore server' });
  }
});

// ===================== REGISTER =====================
router.post('/register', async (req, res) => {
  const { nome, email, password, tipo } = req.body;
  if (!nome || !email || !password)
    return res.status(400).json({ message: 'Nome, email e password richiesti' });

  const client = await pool.connect();

  try {
    const userRes = await client.query('SELECT id FROM utente WHERE email=$1', [email]);
    if (userRes.rows.length)
      return res.status(409).json({ message: 'Email già registrata' });

    const hashed = await bcrypt.hash(password, 10);

    const insertRes = await client.query(
      `INSERT INTO utente (nome, email, password, tipo)
       VALUES ($1, $2, $3, $4)
       RETURNING id, tipo, email, nome`,
      [nome, email, hashed, tipo || 'cliente']
    );

    const user = insertRes.rows[0];

    const jwtPayload = {
      id: user.id,
      role: user.tipo,
      email: user.email,
      nome: user.nome
    };

    const jwtToken = jwt.sign(jwtPayload, JWT_SECRET, { expiresIn: '7d' });

    res.cookie('token', jwtToken, cookieOptions);
    res.json({ ...jwtPayload, token: jwtToken });
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

    let userRes = await client.query(
      'SELECT id, tipo, email, nome FROM utente WHERE email=$1',
      [email]
    );

    let user;

    if (userRes.rows.length) {
      user = userRes.rows[0];
    } else {
      const randomPassword = crypto.randomBytes(16).toString('hex');
      const hashed = await bcrypt.hash(randomPassword, 10);

      const insertRes = await client.query(
        `INSERT INTO utente (nome, email, password, tipo)
         VALUES ($1, $2, $3, $4)
         RETURNING id, tipo, email, nome`,
        [nome, email, hashed, 'cliente']
      );

      user = insertRes.rows[0];
    }

    const jwtPayload = {
      id: user.id,
      role: user.tipo,
      email: user.email,
      nome: user.nome
    };

    const jwtToken = jwt.sign(jwtPayload, JWT_SECRET, { expiresIn: '7d' });

    res.cookie('token', jwtToken, cookieOptions);
    res.json({ ...jwtPayload, token: jwtToken });
  } catch (err) {
    console.error('❌ Google login error:', err);
    res.status(500).json({ message: 'Login Google fallito' });
  } finally {
    client.release();
  }
});

// ===================== ME =====================
router.get('/me', (req, res) => {
  const token = req.cookies?.token;
  if (!token) return res.status(401).json({ message: 'Non autenticato' });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    res.json({ ...payload, token });
  } catch (err) {
    console.error('❌ Token non valido:', err.message);
    return res.status(401).json({ message: 'Token non valido' });
  }
});

// ===================== LOGOUT =====================
router.post('/logout', (req, res) => {
  res.clearCookie('token', {
    ...cookieOptions,
    maxAge: 0
  });
  res.json({ message: 'Logout eseguito' });
});

// ===================== OTP =====================

// INVIO OTP
router.post('/otp/send', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ message: 'Numero mancante' });

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minuti

  try {
    const userRes = await pool.query('SELECT id FROM utente WHERE phone=$1', [phone]);

    if (userRes.rows.length) {
      // aggiorna OTP per utente esistente
      await pool.query(
        'UPDATE utente SET otp_code=$1, otp_expires=$2 WHERE phone=$3',
        [otp, expiresAt, phone]
      );
    } else {
      // crea nuovo utente OTP temporaneo
      const tempEmail = `otp_${phone}@example.com`; // email fittizia unica
      const tempPassword = crypto.randomBytes(16).toString('hex');

      await pool.query(
        `INSERT INTO utente (nome, email, password, tipo, phone, otp_code, otp_expires)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        ['Utente OTP', tempEmail, tempPassword, 'cliente', phone, otp, expiresAt]
      );
    }

    await twilioClient.messages.create({
      body: `Il tuo codice OTP è: ${otp}`,
      from: process.env.TWILIO_PHONE,
      to: phone,
    });

    res.json({ success: true, message: 'OTP inviato' });
  } catch (err) {
    console.error('❌ OTP send error:', err);
    res.status(500).json({ message: 'Errore invio OTP' });
  }
});

// VERIFICA OTP
router.post('/otp/verify', async (req, res) => {
  const { phone, otp } = req.body;
  if (!phone || !otp) return res.status(400).json({ message: 'Dati mancanti' });

  try {
    const result = await pool.query(
      'SELECT id, tipo, nome, otp_expires FROM utente WHERE phone=$1 AND otp_code=$2',
      [phone, otp]
    );

    if (result.rows.length === 0)
      return res.status(400).json({ message: 'OTP non valido' });

    const user = result.rows[0];

    if (new Date(user.otp_expires) < new Date())
      return res.status(400).json({ message: 'OTP scaduto' });

    // pulisce OTP dal DB
    await pool.query(
      'UPDATE utente SET otp_code=NULL, otp_expires=NULL WHERE id=$1',
      [user.id]
    );

    const jwtPayload = {
      id: user.id,
      role: user.tipo,
      nome: user.nome,
      phone,
    };
    const jwtToken = jwt.sign(jwtPayload, JWT_SECRET, { expiresIn: '7d' });

    res.cookie('token', jwtToken, cookieOptions);
    res.json({ ...jwtPayload, token: jwtToken });
  } catch (err) {
    console.error('❌ OTP verify error:', err);
    res.status(500).json({ message: 'Errore server' });
  }
});
export { router };