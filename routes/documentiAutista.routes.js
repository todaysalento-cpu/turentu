import { Router } from 'express';
import multer from 'multer';
import { pool } from '../db/db.js';
import { uploadFile } from '../helpers/cloudinary.js';
import { authMiddleware } from '../middleware/auth.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

// Documenti da gestire
const documentFields = [
  { name: 'carta_identita', maxCount: 1 },
  { name: 'patente_foto', maxCount: 1 },
  { name: 'certificato_abilitazione', maxCount: 1 },
  { name: 'iscrizione_ruolo', maxCount: 1 },
];

// Mappa nomi frontend → nomi DB validi
const tipoMap: Record<string, string> = {
  foto_profilo: 'foto_profilo',
  carta_identita: 'carta_identita',
  patente_foto: 'patente',
  certificato_abilitazione: 'certificato_abilitazione',
  iscrizione_ruolo: 'iscrizione_ruolo',
};

// POST /autista/documenti → upload documenti
router.post('/', authMiddleware, upload.fields(documentFields), async (req, res) => {
  try {
    const utente_id = req.user.id;
    const fileUrls: Record<string, string> = {};

    for (const field of documentFields) {
      const file = req.files?.[field.name]?.[0];
      if (!file) continue;

      // Carica su Cloudinary
      const url = await uploadFile(file.buffer, file.originalname);
      if (!url) continue;

      fileUrls[field.name] = url;

      // Salva o aggiorna documento nel DB
      await pool.query(
        `INSERT INTO documenti_autista (autista_id, tipo, url)
         VALUES ($1, $2, $3)
         ON CONFLICT (autista_id, tipo)
         DO UPDATE SET url = EXCLUDED.url`,
        [utente_id, tipoMap[field.name], url]
      );
    }

    res.json({ success: true, message: 'Documenti salvati correttamente', fileUrls });
  } catch (err) {
    console.error('❌ Errore /autista/documenti POST:', err);
    res.status(500).json({ success: false, message: 'Errore interno server' });
  }
});

export default router;