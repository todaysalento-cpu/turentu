// ======================= routes/auth.routes.js =======================
import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { pool } from '../db/db.js';
import nodemailer from 'nodemailer';
import crypto from 'crypto';

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'segreto-di-test';

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

// ===================== LOGIN =====================
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  console.log('📥 Tentativo login:', email);

  try {
    const result = await pool.query(
      'SELECT id, email, password, tipo, nome FROM utente WHERE email = $1',
      [email]
    );

    console.log('📦 Risultato query:', result.rows);

    const user = result.rows[0];
    if (!user) {
      console.log('❌ Utente non trovato');
      return res.status(401).json({ message: 'Utente non trovato' });
    }

    const match = await bcrypt.compare(password, user.password);
    console.log('🔑 Password match:', match);

    if (!match) {
      console.log('❌ Password errata');
      return res.status(401).json({ message: 'Password errata' });
    }

    const payload = {
      id: user.id,
      role: user.tipo,
      email: user.email,
      nome: user.nome,
    };

    console.log('✅ Payload pronto:', payload);

    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
    console.log('🛡️ Token generato:', token);

    res.cookie('token', token, {
      httpOnly: true,
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
    });

    console.log('🍪 Cookie settato');

    res.json({ ...payload, token });
  } catch (err) {
    console.error('❌ Auth login error:', err);
    res.status(500).json({ message: 'Errore server' });
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
    httpOnly: true,
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  });

  console.log('🔓 Logout eseguito');
  res.json({ message: 'Logout eseguito' });
});

// ===================== FORGOT PASSWORD =====================
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ message: 'Email richiesta' });

  const client = await pool.connect();
  try {
    const userRes = await client.query(
      'SELECT id, nome FROM utente WHERE email=$1',
      [email]
    );

    if (!userRes.rows.length) {
      console.log('❌ Utente non trovato per forgot-password:', email);
      return res.status(404).json({ message: 'Utente non trovato' });
    }

    const user = userRes.rows[0];
    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 3600 * 1000); // 1 ora

    await client.query(
      `UPDATE utente SET reset_token=$1, reset_expires=$2 WHERE id=$3`,
      [token, expires, user.id]
    );

    const resetLink = `https://tuosito.it/reset-password?token=${token}`;
    await transporter.sendMail({
      from: '"Il tuo sito" <no-reply@tuosito.it>',
      to: email,
      subject: 'Recupero password',
      html: `<p>Ciao ${user.nome},</p>
             <p>Hai richiesto di resettare la tua password.</p>
             <p>Clicca qui per impostarne una nuova:</p>
             <a href="${resetLink}">${resetLink}</a>
             <p>Il link scade tra 1 ora.</p>`
    });

    console.log('📧 Email reset inviata a', email);
    res.json({ message: 'Email inviata con istruzioni per resettare la password' });
  } catch (err) {
    console.error('❌ Forgot-password error:', err);
    res.status(500).json({ message: 'Errore server' });
  } finally {
    client.release();
  }
});

// ===================== RESET PASSWORD =====================
router.post('/reset-password', async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) return res.status(400).json({ message: 'Token e nuova password richiesti' });

  const client = await pool.connect();
  try {
    const userRes = await client.query(
      `SELECT id FROM utente WHERE reset_token=$1 AND reset_expires > NOW()`,
      [token]
    );

    if (!userRes.rows.length) {
      console.log('❌ Token reset non valido o scaduto:', token);
      return res.status(400).json({ message: 'Token non valido o scaduto' });
    }

    const userId = userRes.rows[0].id;
    const hashed = await bcrypt.hash(newPassword, 10);

    await client.query(
      `UPDATE utente SET password=$1, reset_token=NULL, reset_expires=NULL WHERE id=$2`,
      [hashed, userId]
    );

    console.log('✅ Password aggiornata per utente id', userId);
    res.json({ message: 'Password aggiornata con successo' });
  } catch (err) {
    console.error('❌ Reset-password error:', err);
    res.status(500).json({ message: 'Errore server' });
  } finally {
    client.release();
  }
});

// ===================== TEST ROUTE =====================
router.get('/test', (req, res) => {
  console.log('🧪 Test route chiamata');
  res.json({ message: 'Auth routes funzionanti' });
});

export { router };