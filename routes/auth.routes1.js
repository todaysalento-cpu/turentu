// ======================= routes/auth.routes.js =======================
import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { pool } from '../db/db.js';

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'segreto-di-test';

// -------------------- LOGIN --------------------
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const result = await pool.query(
      'SELECT id, email, password, tipo, nome FROM utente WHERE email = $1',
      [email]
    );
    const user = result.rows[0];

    if (!user) return res.status(401).json({ message: 'Utente non trovato' });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ message: 'Password errata' });

    // Payload più completo
    const payload = {
      id: user.id,
      role: user.tipo,
      email: user.email,
      nome: user.nome
    };

    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });

res.cookie('token', token, {
  httpOnly: true,
  sameSite: 'lax',   // 🔥 permette cross-origin (3000 → 3001)
  secure: false,      // in localhost deve essere false
  path: '/',
});


    res.json(payload); // restituisce id, role, email, nome
  } catch (err) {
    console.error('❌ Auth login error:', err);
    res.status(500).json({ message: 'Errore server' });
  }
});

// -------------------- ME --------------------
router.get('/me', (req, res) => {
  const token = req.cookies?.token;
  if (!token) return res.status(401).json({ message: 'Non autenticato' });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    res.json(payload); // { id, role, email, nome }
  } catch (err) {
    return res.status(401).json({ message: 'Token non valido' });
  }
});

// -------------------- LOGOUT --------------------
router.post('/logout', (req, res) => {
  res.clearCookie('token', {
    httpOnly: true,
    sameSite: 'lax',
    secure: false, // localhost
    path: '/',
  });

  res.json({ message: 'Logout eseguito' });
});

export { router };


