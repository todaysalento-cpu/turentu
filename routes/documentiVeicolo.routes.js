import { Router } from 'express';
import multer from 'multer';
import { pool } from '../db/db.js';
import { uploadFile } from '../helpers/cloudinary.js';
import { authMiddleware } from '../middleware/auth.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

const documentFields = [
  { name: 'licenza_ncc', maxCount: 1 },
  { name: 'assicurazione', maxCount: 1 },
  { name: 'libretto', maxCount: 1 },
];

const tipoMapping = {
  licenza_ncc: 'licenza_ncc',
  assicurazione: 'assicurazione',
  libretto: 'libretto',
};

router.post('/', authMiddleware, upload.fields(documentFields), async (req, res) => {
  const driver_id = req.user.id;
  const veicolo_id = parseInt(req.body.veicolo_id);

  console.log(`📥 [UPLOAD DOCUMENTI] Inizio richiesta per driver_id: ${driver_id}, veicolo_id: ${veicolo_id}`);

  try {
    if (!veicolo_id) {
      console.warn('⚠️ [UPLOAD DOCUMENTI] Errore: veicolo_id mancante nel body.');
      return res.status(400).json({ success: false, message: 'ID veicolo mancante' });
    }

    // 1. Controllo validità veicolo
    const veicoloRes = await pool.query(
      'SELECT id FROM veicolo WHERE id=$1 AND driver_id=$2',
      [veicolo_id, driver_id]
    );

    if (veicoloRes.rowCount === 0) {
      console.error(`❌ [UPLOAD DOCUMENTI] Veicolo ${veicolo_id} non trovato o non autorizzato per driver ${driver_id}`);
      return res.status(404).json({ success: false, message: 'Veicolo non trovato' });
    }

    if (!req.files || Object.keys(req.files).length === 0) {
      console.warn('⚠️ [UPLOAD DOCUMENTI] Nessun file inviato nella richiesta.');
      return res.status(400).json({ success: false, message: 'Nessun documento caricato' });
    }

    // 2. Upload file su Cloudinary
    const fileUrls = {};
    for (const field of documentFields) {
      const file = req.files?.[field.name]?.[0];
      if (file) {
        console.log(`📤 [CLOUDINARY] Uploading: ${field.name} (${file.originalname}, ${file.size} bytes)`);
        try {
          const url = await uploadFile(file.buffer, file.originalname);
          if (url) {
            fileUrls[field.name] = url;
            console.log(`✅ [CLOUDINARY] Successo ${field.name}: ${url}`);
          } else {
            console.error(`❌ [CLOUDINARY] Upload fallito per ${field.name}: URL non restituito`);
          }
        } catch (uploadErr) {
          console.error(`💥 [CLOUDINARY] Errore durante upload di ${field.name}:`, uploadErr);
        }
      }
    }

    // 3. Salvataggio documenti nel DB
    const salvati = [];
    for (const [field, url] of Object.entries(fileUrls)) {
      const tipo = tipoMapping[field];
      console.log(`💾 [DATABASE] Tentativo salvataggio: tipo=${tipo}, url=${url}`);
      
      const dbRes = await pool.query(
        `INSERT INTO documenti_autista (autista_id, veicolo_id, tipo, url, stato, created_at)
         VALUES ($1, $2, $3, $4, 'pending', CURRENT_TIMESTAMP)
         ON CONFLICT (autista_id, veicolo_id, tipo)
         DO UPDATE SET
           url = EXCLUDED.url,
           stato = 'pending',
           note_admin = NULL,
           created_at = CURRENT_TIMESTAMP
         RETURNING *`,
        [driver_id, veicolo_id, tipo, url]
      );

      if (dbRes.rows[0]) {
        salvati.push(tipo);
        console.log(`✅ [DATABASE] Salvato con successo:`, dbRes.rows[0].id);
      }
    }

    console.log(`🎉 [UPLOAD DOCUMENTI] Elaborazione completata. Documenti aggiornati: ${salvati.join(', ')}`);
    return res.json({ 
      success: true, 
      message: 'Documenti elaborati', 
      salvati,
      urls: fileUrls 
    });

  } catch (err) {
    console.error('💥 [UPLOAD DOCUMENTI] Errore critico nel server:', err);
    return res.status(500).json({ success: false, message: 'Errore interno server durante il salvataggio dei documenti' });
  }
});

export default router;