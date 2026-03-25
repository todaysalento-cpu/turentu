// routes/autistaProfilo.routes.js
import { Router } from 'express';
import { pool } from '../db/db.js';
import { authMiddleware } from '../middleware/auth.js';

const router = Router();

/**
 * POST /autista/profilo
 * Crea o aggiorna il profilo autista
 */
router.post('/', authMiddleware, async (req, res) => {
  try {
    // 🔥 PRENDI SEMPRE L'UTENTE DAL TOKEN
    const utente_id = req.user.id;

    const {
      nome,
      cognome,
      codice_fiscale,
      patente,
      certificato_ncc = false,
      iban,
      telefono,
      foto_profilo,
      documenti
    } = req.body;

    console.log('👤 USER ID (profilo):', utente_id);
    console.log('📦 BODY:', req.body);

    // Validazione campi obbligatori
    if (!nome || !cognome || !codice_fiscale || !patente || !iban || !telefono) {
      return res.status(400).json({ error: 'Campi obbligatori mancanti' });
    }

    // Controllo se esiste già il profilo
    const existing = await pool.query(
      'SELECT 1 FROM autista_profilo WHERE utente_id = $1',
      [utente_id]
    );

    if (existing.rowCount > 0) {
      // UPDATE
      const updated = await pool.query(
        `UPDATE autista_profilo
         SET nome=$1, cognome=$2, codice_fiscale=$3, patente=$4, certificato_ncc=$5,
             iban=$6, telefono=$7, foto_profilo=$8, documenti=$9, updated_at=NOW()
         WHERE utente_id=$10
         RETURNING *`,
        [
          nome,
          cognome,
          codice_fiscale,
          patente,
          certificato_ncc,
          iban,
          telefono,
          foto_profilo || null,
          documenti || null,
          utente_id
        ]
      );

      return res.json(updated.rows[0]);
    }

    // INSERT
    const inserted = await pool.query(
      `INSERT INTO autista_profilo
       (utente_id, nome, cognome, codice_fiscale, patente, certificato_ncc, iban, telefono, foto_profilo, documenti)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        utente_id,
        nome,
        cognome,
        codice_fiscale,
        patente,
        certificato_ncc,
        iban,
        telefono,
        foto_profilo || null,
        documenti || null
      ]
    );

    res.json(inserted.rows[0]);

  } catch (err) {
    console.error('❌ Errore /autista/profilo:', err);
    res.status(500).json({ error: 'Errore interno server' });
  }
});

/**
 * ✅ GET /autista/profilo/me
 * Recupera il profilo dell'utente loggato
 */
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const utente_id = req.user.id;

    const result = await pool.query(
      'SELECT * FROM autista_profilo WHERE utente_id = $1',
      [utente_id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({});
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Errore GET /autista/profilo/me:', err);
    res.status(500).json({ error: 'Errore interno server' });
  }
});

/**
 * (FACOLTATIVA) GET per admin/debug
 */
router.get('/:utenteId', async (req, res) => {
  try {
    const { utenteId } = req.params;

    const result = await pool.query(
      'SELECT * FROM autista_profilo WHERE utente_id = $1',
      [utenteId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Profilo non trovato' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Errore GET /autista/profilo/:utenteId:', err);
    res.status(500).json({ error: 'Errore interno server' });
  }
});

export default router;