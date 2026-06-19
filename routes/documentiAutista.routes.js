import { Router } from 'express';
import multer from 'multer';
import { pool } from '../db/db.js';
import { uploadFile } from '../helpers/cloudinary.js';
import { authMiddleware } from '../middleware/auth.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

const tipoMap = {
  foto_profilo: 'foto_profilo',
  carta_identita: 'carta_identita',
  patente_foto: 'patente',
  certificato_abilitazione: 'certificato_abilitazione',
  iscrizione_ruolo: 'iscrizione_ruolo',
};

router.post(
  '/',
  authMiddleware,
  upload.any(), 
  async (req, res) => {
    // 1. LOG INIZIALE: Controlliamo cosa arriva dalla richiesta
    console.log('📡 [DEBUG] Nuova richiesta POST /api/autista/profilo');
    console.log('👤 Utente ID:', req.user?.id);
    console.log('📦 Body ricevuto (dati testuali):', JSON.stringify(req.body, null, 2));
    console.log('📂 Numero file ricevuti:', req.files ? req.files.length : 0);

    try {
      const utente_id = req.user.id;
      
      // LOG dei file trovati
      if (req.files) {
        req.files.forEach((f, i) => {
          console.log(`   File ${i}: fieldname=${f.fieldname}, mimetype=${f.mimetype}, size=${f.size}`);
        });
      }

      const { nome, cognome, iban, telefono, nome_titolare_conto, nome_banca } = req.body;
      
      // 2. AGGIORNAMENTO DATI TESTUALI
      console.log('💾 Inizio salvataggio dati testuali...');
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
      console.log('✅ Dati testuali salvati con successo.');

      // 3. GESTIONE FILE
      const fileUrls = {};
      if (req.files && req.files.length > 0) {
        for (const file of req.files) {
          console.log(`🚀 Caricamento file su Cloudinary: ${file.fieldname}`);
          
          const url = await uploadFile(file.buffer, file.originalname);
          if (!url) {
            console.error(`❌ Fallito caricamento per: ${file.fieldname}`);
            continue;
          }

          if (file.fieldname === 'foto_profilo') {
            fileUrls.foto_profilo = url;
            await pool.query(`UPDATE autista_profilo SET foto_profilo = $1 WHERE utente_id = $2`, [url, utente_id]);
          } else if (tipoMap[file.fieldname]) {
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
          console.log(`✅ File ${file.fieldname} salvato su DB.`);
        }
      }

      return res.json({
        success: true,
        message: 'Profilo salvato correttamente',
        fileUrls,
      });

    } catch (err) {
      // 4. LOG ERRORE CRITICO
      console.error('❌ ERRORE CRITICO nel processamento:', err.message);
      console.error('Stack trace:', err.stack);
      
      return res.status(500).json({
        success: false,
        message: 'Errore interno server',
        error: err.message 
      });
    }
  }
);

export default router;