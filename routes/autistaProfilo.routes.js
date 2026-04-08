import { Router } from 'express';
import { pool } from '../db/db.js';
import { authMiddleware } from '../middleware/auth.js';
import multer from 'multer';
import { uploadFile } from '../helpers/cloudinary.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

// ===================== POST PROFILO =====================
router.post(
  '/',
  authMiddleware,
  upload.single('foto_profilo'),
  async (req, res) => {
    try {
      const utente_id = req.user.id;
      const { nome, cognome, telefono, iban, nome_titolare_conto, nome_banca } = req.body;

      if (!nome || !cognome || !telefono || !iban || !nome_titolare_conto || !nome_banca) {
        return res.status(400).json({ success: false, message: 'Campi obbligatori mancanti' });
      }

      let foto_profilo_url = null;
      if (req.file) {
        foto_profilo_url = await uploadFile(req.file.buffer, req.file.originalname);
      }

      const result = await pool.query(
        `
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
          foto_profilo = COALESCE($8, autista_profilo.foto_profilo),
          updated_at = NOW()
        RETURNING *;
        `,
        [
          utente_id,
          nome,
          cognome,
          telefono,
          iban,
          nome_titolare_conto,
          nome_banca,
          foto_profilo_url,
        ]
      );

      res.json({ success: true, data: result.rows[0] });
    } catch (err) {
      console.error('❌ Errore /autista/profilo POST:', err);
      res.status(500).json({ success: false, message: 'Errore interno server' });
    }
  }
);

// ===================== GET PROFILO LOGGATO CON DOCUMENTI =====================
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const utente_id = req.user.id;

    // 1️⃣ Recupera dati profilo
    const profiloResult = await pool.query(
      'SELECT * FROM autista_profilo WHERE utente_id = $1',
      [utente_id]
    );
    const profilo = profiloResult.rows[0] || null;

    if (!profilo) {
      return res.json({ success: true, data: null });
    }

    // 2️⃣ Recupera documenti
    const docResult = await pool.query(
      'SELECT tipo, url FROM documenti_autista WHERE autista_id = $1',
      [utente_id]
    );

    // Mappa DB -> frontend (JS puro, niente TypeScript)
    const tipoMap = {
      foto_profilo: 'foto_profilo',
      carta_identita: 'carta_identita',
      patente: 'patente_foto',               // ← mappatura corretta
      certificato_abilitazione: 'certificato_abilitazione',
      iscrizione_ruolo: 'iscrizione_ruolo',
      licenza_ncc: 'licenza_ncc',
      assicurazione: 'assicurazione',
      libretto: 'libretto',
    };

    const documenti = {};
    docResult.rows.forEach(doc => {
      const key = tipoMap[doc.tipo];
      if (key && doc.url) documenti[key] = doc.url;
    });

    // 3️⃣ Componi risposta finale
    const responseData = {
      ...profilo,
      documenti,
    };

    res.json({ success: true, data: responseData });

  } catch (err) {
    console.error('❌ Errore GET /autista/profilo/me:', err);
    res.status(500).json({ success: false, message: 'Errore interno server' });
  }
});

export default router;