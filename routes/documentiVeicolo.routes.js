// routes/documentiVeicolo.routes.js
import { Router } from 'express';
import multer from 'multer';
import { pool } from '../db/db.js';
import { uploadFile } from '../helpers/cloudinary.js';
import { authMiddleware } from '../middleware/auth.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

// ===================== CAMPi DOCUMENTI VEICOLO =====================
const documentFields = [
  { name: 'licenza_ncc', maxCount: 1 },
  { name: 'assicurazione', maxCount: 1 },
  { name: 'libretto', maxCount: 1 },
];

// ===================== MAPPING TIPI =====================
const tipoMapping = {
  licenza_ncc: 'licenza_ncc',
  assicurazione: 'assicurazione',
  libretto: 'libretto',
};

// ===================== POST UPLOAD DOCUMENTI =====================
router.post('/', authMiddleware, upload.fields(documentFields), async (req, res) => {
  try {
    const veicolo_id = parseInt(req.body.veicolo_id);
    const driver_id = req.user.id;

    console.log('🚀 Richiesta upload documenti', {
      veicolo_id,
      driver_id,
      files: req.files ? Object.keys(req.files) : null,
    });

    if (!veicolo_id) {
      console.warn('❌ ID veicolo mancante');
      return res.status(400).json({ success: false, message: 'ID veicolo mancante' });
    }

    // Controllo veicolo esistente
    const veicoloRes = await pool.query(
      'SELECT id FROM veicolo WHERE id=$1 AND driver_id=$2',
      [veicolo_id, driver_id]
    );
    if (!veicoloRes.rowCount) {
      console.warn('❌ Veicolo non trovato', { veicolo_id, driver_id });
      return res.status(404).json({ success: false, message: 'Veicolo non trovato' });
    }

    if (!req.files || Object.keys(req.files).length === 0) {
      console.warn('❌ Nessun documento caricato');
      return res.status(400).json({ success: false, message: 'Nessun documento caricato' });
    }

    // Upload file su Cloudinary
    const fileUrls = {};
    for (const field of documentFields) {
      const file = req.files?.[field.name]?.[0];
      if (file) {
        console.log(`📤 Upload file: ${field.name} - ${file.originalname} (${file.mimetype}, ${file.size} bytes)`);
        const url = await uploadFile(file.buffer, file.originalname);
        if (url) {
          fileUrls[field.name] = url;
          console.log(`✅ File caricato su Cloudinary: ${url}`);
        } else {
          console.error(`❌ Upload fallito per ${field.name}`);
        }
      }
    }

    // Salvataggio documenti nel DB usando documenti_autista
    for (const [field, url] of Object.entries(fileUrls)) {
      if (!url) continue;

      const dbRes = await pool.query(
        `INSERT INTO documenti_autista (autista_id, veicolo_id, tipo, url)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (autista_id, veicolo_id, tipo)
         DO UPDATE SET
           url = EXCLUDED.url,
           stato = 'pending',
           note_admin = NULL,
           created_at = CURRENT_TIMESTAMP
         RETURNING *`,
        [driver_id, veicolo_id, tipoMapping[field], url]
      );

      console.log(`💾 Documento salvato nel DB: tipo=${field}`, dbRes.rows[0]);
    }

    console.log('🎉 Tutti i documenti elaborati correttamente');

    return res.json({
      success: true,
      message: 'Documenti veicolo salvati correttamente',
      fileUrls,
    });

  } catch (err) {
    console.error('💥 Errore /documenti veicolo:', err);
    return res.status(500).json({ success: false, message: 'Errore interno server' });
  }
});

export default router;