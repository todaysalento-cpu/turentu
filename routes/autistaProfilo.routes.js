import { Router } from 'express';
import { pool } from '../db/db.js';
import { authMiddleware } from '../middleware/auth.js';
import multer from 'multer';

// ✅ Configurazione multer per upload immagini
const storage = multer.memoryStorage();
const upload = multer({ storage });

const router = Router();

/**
 * POST /autista/profilo
 * Crea o aggiorna il profilo autista (solo dati + foto_profilo)
 */
router.post(
  '/',
  authMiddleware,
  upload.single('foto_profilo'), // solo foto_profilo
  async (req, res) => {
    try {
      const utente_id = req.user.id;
      const { nome, cognome, telefono, iban, nome_titolare_conto, nome_banca } = req.body;

      // Validazione campi obbligatori
      if (!nome || !cognome || !telefono || !iban || !nome_titolare_conto || !nome_banca) {
        return res.status(400).json({ success: false, message: 'Campi obbligatori mancanti' });
      }

      const foto_profilo = req.file?.buffer || null;

      // INSERT o UPDATE (solo dati + foto_profilo)
      const query = `
        INSERT INTO autista_profilo
          (utente_id, nome, cognome, telefono, iban, nome_titolare_conto, nome_banca, foto_profilo, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8, NOW(), NOW())
        ON CONFLICT (utente_id)
        DO UPDATE SET
          nome = $2,
          cognome = $3,
          telefono = $4,
          iban = $5,
          nome_titolare_conto = $6,
          nome_banca = $7,
          foto_profilo = $8,
          updated_at = NOW()
        RETURNING *;
      `;

      const values = [
        utente_id,
        nome,
        cognome,
        telefono,
        iban,
        nome_titolare_conto,
        nome_banca,
        foto_profilo,
      ];

      const result = await pool.query(query, values);
      res.json({ success: true, data: result.rows[0] });

    } catch (err) {
      console.error('❌ Errore /autista/profilo POST:', err);
      res.status(500).json({ success: false, message: 'Errore interno server' });
    }
  }
);

/**
 * GET /autista/profilo/me
 * Recupera il profilo dell'utente loggato
 */
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const utente_id = req.user.id;
    const result = await pool.query(
      'SELECT * FROM autista_profilo WHERE utente_id = $1',
      [utente_id]
    );
    res.json({ success: true, data: result.rows[0] || null });
  } catch (err) {
    console.error('❌ Errore GET /autista/profilo/me:', err);
    res.status(500).json({ success: false, message: 'Errore interno server' });
  }
});

/**
 * GET per admin/debug
 */
router.get('/:utenteId', async (req, res) => {
  try {
    const { utenteId } = req.params;
    const result = await pool.query(
      'SELECT * FROM autista_profilo WHERE utente_id = $1',
      [utenteId]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: 'Profilo non trovato' });
    }
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error('❌ Errore GET /autista/profilo/:utenteId:', err);
    res.status(500).json({ success: false, message: 'Errore interno server' });
  }
});

export default router;