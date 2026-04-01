// routes/autistaProfilo.routes.js
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
 * Crea o aggiorna il profilo autista (supporta file FormData)
 */
router.post(
  '/',
  authMiddleware,
  upload.fields([
    { name: 'foto_profilo', maxCount: 1 },
    { name: 'carta_identita', maxCount: 1 },
    { name: 'patente_foto', maxCount: 1 },
    { name: 'certificato_abilitazione', maxCount: 1 },
    { name: 'iscrizione_ruolo', maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const utente_id = req.user.id;

      const {
        nome,
        cognome,
        telefono,
        iban,
        nome_titolare_conto,
        nome_banca,
      } = req.body;

      console.log('👤 USER ID (profilo):', utente_id);
      console.log('📦 BODY:', req.body);

      // Validazione campi obbligatori aggiornati
      if (!nome || !cognome || !telefono || !iban || !nome_titolare_conto || !nome_banca) {
        return res.status(400).json({ error: 'Campi obbligatori mancanti' });
      }

      // Gestione file caricati
      const fileFields = ['foto_profilo','carta_identita','patente_foto','certificato_abilitazione','iscrizione_ruolo'];
      const files = {};
      fileFields.forEach(field => {
        if (req.files[field]?.[0]) {
          files[field] = req.files[field][0].buffer; // salva il buffer
        }
      });

      // Controllo se esiste già il profilo
      const existing = await pool.query(
        'SELECT 1 FROM autista_profilo WHERE utente_id = $1',
        [utente_id]
      );

      if (existing.rowCount > 0) {
        // UPDATE
        const updated = await pool.query(
          `UPDATE autista_profilo
           SET nome=$1, cognome=$2, telefono=$3, iban=$4, nome_titolare_conto=$5,
               nome_banca=$6, foto_profilo=$7, carta_identita=$8, patente_foto=$9,
               certificato_abilitazione=$10, iscrizione_ruolo=$11, updated_at=NOW()
           WHERE utente_id=$12
           RETURNING *`,
          [
            nome,
            cognome,
            telefono,
            iban,
            nome_titolare_conto,
            nome_banca,
            files.foto_profilo || null,
            files.carta_identita || null,
            files.patente_foto || null,
            files.certificato_abilitazione || null,
            files.iscrizione_ruolo || null,
            utente_id,
          ]
        );

        return res.json(updated.rows[0]);
      }

      // INSERT
      const inserted = await pool.query(
        `INSERT INTO autista_profilo
         (utente_id, nome, cognome, telefono, iban, nome_titolare_conto, nome_banca,
          foto_profilo, carta_identita, patente_foto, certificato_abilitazione, iscrizione_ruolo)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING *`,
        [
          utente_id,
          nome,
          cognome,
          telefono,
          iban,
          nome_titolare_conto,
          nome_banca,
          files.foto_profilo || null,
          files.carta_identita || null,
          files.patente_foto || null,
          files.certificato_abilitazione || null,
          files.iscrizione_ruolo || null,
        ]
      );

      res.json(inserted.rows[0]);

    } catch (err) {
      console.error('❌ Errore /autista/profilo:', err);
      res.status(500).json({ error: 'Errore interno server' });
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
      return res.status(404).json({ error: 'Profilo non trovato' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Errore GET /autista/profilo/:utenteId:', err);
    res.status(500).json({ error: 'Errore interno server' });
  }
});

export default router;