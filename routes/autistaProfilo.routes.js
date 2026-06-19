import { Router } from 'express';
import { pool } from '../db/db.js';
import { authMiddleware } from '../middleware/auth.js';
import multer from 'multer';
import { uploadFile } from '../helpers/cloudinary.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

const TIPO_DOCUMENTO_MAP = {
  foto_profilo: 'foto_profilo',
  carta_identita: 'carta_identita',
  patente: 'patente', // Mappatura corretta verso DB
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
  // Cambio fondamentale: accetta qualsiasi campo inviato dal FormData
  upload.any(), 
  async (req, res) => {
    try {
      const utente_id = req.user.id;
      const { nome, cognome, telefono, iban, nome_titolare_conto, nome_banca } = req.body;

      if (!nome || !cognome || !telefono || !iban || !nome_titolare_conto || !nome_banca) {
        return res.status(400).json({ success: false, message: 'Campi obbligatori mancanti' });
      }

      // 1. Aggiornamento/Inserimento dati profilo
      const result = await pool.query(
        `INSERT INTO autista_profilo 
          (utente_id, nome, cognome, telefono, iban, nome_titolare_conto, nome_banca, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         ON CONFLICT (utente_id)
         DO UPDATE SET
           nome = EXCLUDED.nome,
           cognome = EXCLUDED.cognome,
           telefono = EXCLUDED.telefono,
           iban = EXCLUDED.iban,
           nome_titolare_conto = EXCLUDED.nome_titolare_conto,
           nome_banca = EXCLUDED.nome_banca,
           updated_at = NOW()
         RETURNING *;`,
        [utente_id, nome, cognome, telefono, iban, nome_titolare_conto, nome_banca]
      );

      // 2. Elaborazione dinamica di tutti i file inviati
      if (req.files && req.files.length > 0) {
        for (const file of req.files) {
          const url = await uploadFile(file.buffer, file.originalname);
          if (!url) continue;

          if (file.fieldname === 'foto_profilo') {
            await pool.query(`UPDATE autista_profilo SET foto_profilo = $1 WHERE utente_id = $2`, [url, utente_id]);
          } else if (TIPO_DOCUMENTO_MAP[file.fieldname]) {
            await pool.query(
              `INSERT INTO documenti_autista (autista_id, tipo, url, stato)
               VALUES ($1, $2, $3, 'pending')
               ON CONFLICT (autista_id, tipo)
               DO UPDATE SET url = EXCLUDED.url, stato = 'pending', note_admin = NULL`,
              [utente_id, TIPO_DOCUMENTO_MAP[file.fieldname], url]
            );
          }
        }
      }

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

    const [profiloRes, docRes] = await Promise.all([
      pool.query('SELECT * FROM autista_profilo WHERE utente_id = $1', [utente_id]),
      pool.query('SELECT tipo, url FROM documenti_autista WHERE autista_id = $1', [utente_id])
    ]);

    const profilo = profiloRes.rows[0];
    if (!profilo) return res.json({ success: true, data: null });

    const documenti = {};
    docRes.rows.forEach(({ tipo, url }) => {
      // Invertiamo il mapping per restituire la chiave corretta al frontend
      const frontendKey = Object.keys(TIPO_DOCUMENTO_MAP).find(key => TIPO_DOCUMENTO_MAP[key] === tipo) || tipo;
      documenti[frontendKey] = url;
    });

    res.json({ success: true, data: { ...profilo, documenti } });
  } catch (err) {
    console.error('❌ Errore GET /autista/profilo/me:', err);
    res.status(500).json({ success: false, message: 'Errore interno server' });
  }
});

export default router;