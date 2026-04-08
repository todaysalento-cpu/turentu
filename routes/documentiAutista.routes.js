import { Router } from 'express';
import multer from 'multer';
import { pool } from '../db/db.js';
import { uploadFile } from '../helpers/cloudinary.js';
import { authMiddleware } from '../middleware/auth.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

// ===================== DOCUMENTI =====================
const documentFields = [
  { name: 'carta_identita', maxCount: 1 },
  { name: 'patente_foto', maxCount: 1 },
  { name: 'certificato_abilitazione', maxCount: 1 },
  { name: 'iscrizione_ruolo', maxCount: 1 },
];

// ===================== MAPPING FRONTEND -> DB =====================
const tipoMap = {
  foto_profilo: 'foto_profilo',
  carta_identita: 'carta_identita',
  patente_foto: 'patente', // <-- mapping corretto per il DB
  certificato_abilitazione: 'certificato_abilitazione',
  iscrizione_ruolo: 'iscrizione_ruolo',
};

// ===================== ROUTE =====================
router.post(
  '/',
  authMiddleware,
  upload.fields([{ name: 'foto_profilo', maxCount: 1 }, ...documentFields]),
  async (req, res) => {
    try {
      const utente_id = req.user.id;
      const fileUrls = {};

      console.log('✅ User ID:', utente_id);
      console.log('📂 Files ricevuti:', req.files);

      // ===================== FOTO PROFILO =====================
      const fotoFile = req.files?.foto_profilo?.[0];
      if (fotoFile) {
        console.log('📌 Foto profilo:', fotoFile.originalname);
        const url = await uploadFile(fotoFile.buffer, fotoFile.originalname);
        if (url) {
          fileUrls.foto_profilo = url;

          await pool.query(
            `INSERT INTO autista_profilo (utente_id, foto_profilo, updated_at)
             VALUES ($1, $2, NOW())
             ON CONFLICT (utente_id)
             DO UPDATE SET foto_profilo = EXCLUDED.foto_profilo, updated_at = NOW()`,
            [utente_id, url]
          );
        }
      }

      // ===================== DOCUMENTI =====================
      for (const field of documentFields) {
        const file = req.files?.[field.name]?.[0];

        if (!file) {
          console.log(`⚠️ Nessun file per ${field.name}`);
          continue;
        }

        console.log(`📂 Upload ${field.name}:`, file.originalname);
        const url = await uploadFile(file.buffer, file.originalname);
        if (!url) {
          console.log(`❌ Upload fallito: ${field.name}`);
          continue;
        }

        // Usa mapping per il DB, ma mantiene chiave frontend per il client
        const tipoDb = tipoMap[field.name];
        fileUrls[field.name] = url;

        await pool.query(
          `INSERT INTO documenti_autista (autista_id, tipo, url)
           VALUES ($1, $2, $3)
           ON CONFLICT (autista_id, tipo)
           DO UPDATE SET
             url = EXCLUDED.url,
             stato = 'pending',
             note_admin = NULL`,
          [utente_id, tipoDb, url]
        );

        console.log(`✅ Salvato DB: ${tipoDb}`);
      }

      console.log('📤 RESPONSE:', fileUrls);

      return res.json({
        success: true,
        message: 'Documenti e foto_profilo salvati correttamente',
        fileUrls,
      });

    } catch (err) {
      console.error('❌ Errore /autista/documenti POST:', err);
      return res.status(500).json({
        success: false,
        message: 'Errore interno server',
      });
    }
  }
);

export default router;