import { Router } from 'express';
import multer from 'multer';
import { pool } from '../db/db.js';
import { uploadFile } from '../helpers/cloudinary.js';
import { authMiddleware } from '../middleware/auth.js';

const router = Router();
// Configurazione memoryStorage per buffer
const upload = multer({ storage: multer.memoryStorage() });

const documentFields = [
  { name: 'carta_identita', maxCount: 1 },
  { name: 'patente_foto', maxCount: 1 },
  { name: 'certificato_abilitazione', maxCount: 1 },
  { name: 'iscrizione_ruolo', maxCount: 1 },
];

const tipoMap = {
  foto_profilo: 'foto_profilo',
  carta_identita: 'carta_identita',
  patente_foto: 'patente',
  certificato_abilitazione: 'certificato_abilitazione',
  iscrizione_ruolo: 'iscrizione_ruolo',
};

// ===================== ROUTE =====================
router.post(
  '/',
  authMiddleware,
  // Usiamo .fields per i file. Multer ignorerà i campi di testo (che finiranno in req.body)
  upload.fields([{ name: 'foto_profilo', maxCount: 1 }, ...documentFields]),
  async (req, res) => {
    try {
      const utente_id = req.user.id;
      const fileUrls = {};

      // LOG PER DEBUG: controlla cosa ricevi
      console.log('✅ User ID:', utente_id);
      console.log('📝 Campi di testo ricevuti (body):', req.body);
      console.log('📂 Files ricevuti:', req.files ? Object.keys(req.files) : 'Nessuno');

      // 1. GESTIONE FOTO PROFILO
      const fotoFile = req.files?.foto_profilo?.[0];
      if (fotoFile) {
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

      // 2. GESTIONE DOCUMENTI
      for (const field of documentFields) {
        const file = req.files?.[field.name]?.[0];

        if (!file) continue;

        const url = await uploadFile(file.buffer, file.originalname);
        if (!url) continue;

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
      }

      // 3. (OPZIONALE) GESTIONE DATI TESTUALI
      // Se devi salvare anche nome/cognome/iban che arrivano dal form:
      if (req.body.nome || req.body.cognome) {
          await pool.query(
              `UPDATE autista_profilo SET nome = $1, cognome = $2, iban = $3 WHERE utente_id = $4`,
              [req.body.nome, req.body.cognome, req.body.iban, utente_id]
          );
      }

      return res.json({
        success: true,
        message: 'Dati, documenti e foto salvati correttamente',
        fileUrls,
      });

    } catch (err) {
      console.error('❌ Errore critico nel salvataggio profilo:', err);
      return res.status(500).json({
        success: false,
        message: 'Errore interno server',
        error: err.message 
      });
    }
  }
);

export default router;