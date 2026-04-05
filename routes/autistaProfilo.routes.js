import { Router } from 'express';
import { pool } from '../db/db.js';
import { authMiddleware } from '../middleware/auth.js';
import multer from 'multer';

// Configurazione multer per foto_profilo
const upload = multer({ storage: multer.memoryStorage() });

const router = Router();

// POST /autista/profilo → dati + foto_profilo
router.post('/', authMiddleware, upload.single('foto_profilo'), async (req, res) => {
  try {
    const utente_id = req.user.id;
    const { nome, cognome, telefono, iban, nome_titolare_conto, nome_banca } = req.body;

    if (!nome || !cognome || !telefono || !iban || !nome_titolare_conto || !nome_banca) {
      return res.status(400).json({ success: false, message: 'Campi obbligatori mancanti' });
    }

    const foto_profilo = req.file?.buffer || null;

    await pool.query(
      `INSERT INTO autista_profilo
        (utente_id, nome, cognome, telefono, iban, nome_titolare_conto, nome_banca, foto_profilo, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now(), now())
       ON CONFLICT (utente_id)
       DO UPDATE SET
         nome = $2,
         cognome = $3,
         telefono = $4,
         iban = $5,
         nome_titolare_conto = $6,
         nome_banca = $7,
         foto_profilo = $8,
         updated_at = now()`,
      [utente_id, nome, cognome, telefono, iban, nome_titolare_conto, nome_banca, foto_profilo]
    );

    res.json({ success: true, message: 'Profilo aggiornato correttamente' });
  } catch (err) {
    console.error('❌ Errore /autista/profilo POST:', err);
    res.status(500).json({ success: false, message: 'Errore interno server' });
  }
});

// GET /autista/profilo/me → recupera solo profilo
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const utente_id = req.user.id;
    const result = await pool.query('SELECT * FROM autista_profilo WHERE utente_id = $1', [utente_id]);
    res.json({ success: true, data: result.rows[0] || null });
  } catch (err) {
    console.error('❌ Errore GET /autista/profilo/me:', err);
    res.status(500).json({ success: false, message: 'Errore interno server' });
  }
});

// GET /autista/profilo/:utenteId → admin/debug
router.get('/:utenteId', async (req, res) => {
  try {
    const { utenteId } = req.params;
    const result = await pool.query('SELECT * FROM autista_profilo WHERE utente_id = $1', [utenteId]);
    if (!result.rows[0]) return res.status(404).json({ success: false, message: 'Profilo non trovato' });
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error('❌ Errore GET /autista/profilo/:utenteId:', err);
    res.status(500).json({ success: false, message: 'Errore interno server' });
  }
});

export default router;