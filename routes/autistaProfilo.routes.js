import { Router } from 'express';
import { pool } from '../db/db.js';
import { authMiddleware } from '../middleware/auth.js';
import multer from 'multer';
import { uploadFile } from '../helpers/cloudinary.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

// Mappa costante per il mapping DB -> Frontend
const TIPO_DOCUMENTO_MAP = {
  foto_profilo: 'foto_profilo',
  carta_identita: 'carta_identita',
  patente: 'patente_foto',
  certificato_abilitazione: 'certificato_abilitazione',
  iscrizione_ruolo: 'iscrizione_ruolo',
  licenza_ncc: 'licenza_ncc',
  assicurazione: 'assicurazione',
  libretto: 'libretto',
};

// ===================== POST PROFILO =====================
router.post(
  '/',
  authMiddleware,
  upload.single('foto_profilo'),
  async (req, res) => {
    try {
      const utente_id = req.user.id;
      const { nome, cognome, telefono, iban, nome_titolare_conto, nome_banca } = req.body;

      // Validazione basica
      if (!nome || !cognome || !telefono || !iban || !nome_titolare_conto || !nome_banca) {
        return res.status(400).json({ success: false, message: 'Campi obbligatori mancanti' });
      }

      let foto_profilo_url = null;
      if (req.file) {
        foto_profilo_url = await uploadFile(req.file.buffer, req.file.originalname);
      }

      // Query di upsert
      const result = await pool.query(
        `INSERT INTO autista_profilo 
          (utente_id, nome, cognome, telefono, iban, nome_titolare_conto, nome_banca, foto_profilo, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
         ON CONFLICT (utente_id)
         DO UPDATE SET
           nome = EXCLUDED.nome,
           cognome = EXCLUDED.cognome,
           telefono = EXCLUDED.telefono,
           iban = EXCLUDED.iban,
           nome_titolare_conto = EXCLUDED.nome_titolare_conto,
           nome_banca = EXCLUDED.nome_banca,
           foto_profilo = COALESCE(EXCLUDED.foto_profilo, autista_profilo.foto_profilo),
           updated_at = NOW()
         RETURNING *;`,
        [utente_id, nome, cognome, telefono, iban, nome_titolare_conto, nome_banca, foto_profilo_url]
      );

      res.json({ success: true, data: result.rows[0] });
    } catch (err) {
      console.error('❌ Errore /autista/profilo POST:', err);
      res.status(500).json({ success: false, message: 'Errore interno server' });
    }
  }
);

// ===================== GET PROFILO LOGGATO =====================
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const utente_id = req.user.id;

    // 1️⃣ Recupero parallelo per performance
    const [profiloRes, docRes] = await Promise.all([
      pool.query('SELECT * FROM autista_profilo WHERE utente_id = $1', [utente_id]),
      pool.query('SELECT tipo, url FROM documenti_autista WHERE autista_id = $1', [utente_id])
    ]);

    const profilo = profiloRes.rows[0];
    if (!profilo) {
      return res.json({ success: true, data: null });
    }

    // 2️⃣ Trasformazione sicura dei documenti
    const documenti = {};
    docRes.rows.forEach(({ tipo, url }) => {
      // Usa il mapping se esiste, altrimenti usa il nome originale del tipo dal DB
      const key = TIPO_DOCUMENTO_MAP[tipo] || tipo;
      documenti[key] = url;
    });

    res.json({ 
      success: true, 
      data: { ...profilo, documenti } 
    });

  } catch (err) {
    console.error('❌ Errore GET /autista/profilo/me:', err);
    res.status(500).json({ success: false, message: 'Errore interno server' });
  }
});

export default router;