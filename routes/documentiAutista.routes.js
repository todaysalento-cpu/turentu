import { Router } from 'express';
import multer from 'multer';
import { pool } from '../db/db.js';
import { uploadFile } from '../helpers/cloudinary.js';
import { authMiddleware } from '../middleware/auth.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

// Mappa per il DB
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
  // USIAMO .any() per accettare ogni tipo di campo inviato dal FormData.
  // Questo risolve l'errore "Unexpected field" una volta per tutte.
  upload.any(), 
  async (req, res) => {
    try {
      const utente_id = req.user.id;
      
      // 1. ESTRAZIONE DATI TESTUALI (dal body)
      const { nome, cognome, iban, telefono, nome_titolare_conto, nome_banca } = req.body;
      
      // 2. AGGIORNAMENTO DATI TESTUALI
      await pool.query(
        `INSERT INTO autista_profilo (utente_id, nome, cognome, iban, telefono, nome_titolare_conto, nome_banca, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         ON CONFLICT (utente_id)
         DO UPDATE SET 
            nome = EXCLUDED.nome, 
            cognome = EXCLUDED.cognome, 
            iban = EXCLUDED.iban, 
            telefono = EXCLUDED.telefono, 
            nome_titolare_conto = EXCLUDED.nome_titolare_conto, 
            nome_banca = EXCLUDED.nome_banca, 
            updated_at = NOW()`,
        [utente_id, nome, cognome, iban, telefono, nome_titolare_conto, nome_banca]
      );

      // 3. GESTIONE FILE (estratta da req.files che ora è un array)
      const fileUrls = {};
      if (req.files && req.files.length > 0) {
        for (const file of req.files) {
          const url = await uploadFile(file.buffer, file.originalname);
          if (!url) continue;

          // Se è la foto profilo
          if (file.fieldname === 'foto_profilo') {
            fileUrls.foto_profilo = url;
            await pool.query(
              `UPDATE autista_profilo SET foto_profilo = $1 WHERE utente_id = $2`,
              [url, utente_id]
            );
          } 
          // Se è un documento
          else if (tipoMap[file.fieldname]) {
            const tipoDb = tipoMap[file.fieldname];
            fileUrls[file.fieldname] = url;
            await pool.query(
              `INSERT INTO documenti_autista (autista_id, tipo, url, stato)
               VALUES ($1, $2, $3, 'pending')
               ON CONFLICT (autista_id, tipo)
               DO UPDATE SET url = EXCLUDED.url, stato = 'pending', note_admin = NULL`,
              [utente_id, tipoDb, url]
            );
          }
        }
      }

      return res.json({
        success: true,
        message: 'Profilo salvato correttamente',
        fileUrls,
      });

    } catch (err) {
      console.error('❌ Errore critico:', err);
      return res.status(500).json({
        success: false,
        message: 'Errore interno server',
        error: err.message 
      });
    }
  }
);

export default router;