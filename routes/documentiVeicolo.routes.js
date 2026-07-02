import { Router } from 'express';
import multer from 'multer';
import { pool } from '../db/db.js';
import { uploadFile } from '../helpers/cloudinary.js';
import { authMiddleware } from '../middleware/auth.js';
import { CacheManager } from '../utils/cacheManager.js';

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

/* ======================================================
   UPLOAD DOCUMENTI
====================================================== */
router.post(
  '/',
  authMiddleware,
  (req, res, next) => {
    console.log(`\n🔍 [DOC_UPLOAD] Richiesta POST ricevuta`);
    console.log(`   Headers Content-Type: ${req.headers['content-type']}`);
    next();
  },
  upload.fields(documentFields),
  async (req, res) => {
    const driver_id = req.user.id;
    const veicolo_id = Number(req.body.veicolo_id);

    console.log(`📥 [DOC_UPLOAD] Inizio elaborazione`);
    console.log(`   Driver ID: ${driver_id}`);
    console.log(`   Veicolo ID: ${veicolo_id}`);

    // LOG DI DEBUG FILE INTERCETTATI
    if (req.files) {
      console.log(`   ✅ Multer ha trovato campi: ${Object.keys(req.files).join(', ')}`);
      Object.keys(req.files).forEach(field => {
        const file = req.files[field][0];
        console.log(`      - Field [${field}]: ${file.originalname} (${file.size} bytes)`);
      });
    } else {
      console.log(`   ❌ [DOC_UPLOAD] Multer NON ha trovato alcun file.`);
      console.log(`      Verifica che i nomi nel FormData lato client siano: ${documentFields.map(f => f.name).join(', ')}`);
    }

    try {
      if (!veicolo_id) {
        return res.status(400).json({ success: false, message: 'veicolo_id mancante' });
      }

      // Validazione esistenza veicolo
      const veicoloRes = await pool.query(
        'SELECT id FROM veicolo WHERE id=$1 AND driver_id=$2',
        [veicolo_id, driver_id]
      );

      if (veicoloRes.rowCount === 0) {
        return res.status(404).json({ success: false, message: 'Veicolo non trovato o non autorizzato' });
      }

      if (!req.files || Object.keys(req.files).length === 0) {
        return res.status(400).json({ success: false, message: 'Nessun file presente nella richiesta' });
      }

      const fileUrls = {};

      // Elaborazione file
      for (const field of documentFields) {
        const file = req.files?.[field.name]?.[0];
        if (!file) continue;

        try {
          console.log(`   🚀 Uploading ${field.name} su Cloudinary...`);
          const url = await uploadFile(file.buffer, file.originalname);

          if (url) {
            fileUrls[field.name] = url;
            console.log(`   ✅ ${field.name} caricato con successo.`);
          }
        } catch (err) {
          console.error(`   ❌ Errore Cloudinary per ${field.name}:`, err);
        }
      }

      if (Object.keys(fileUrls).length === 0) {
        throw new Error('Nessun file è stato caricato con successo su Cloudinary');
      }

      // Salva nel DB
      await pool.query('BEGIN');
      const salvati = [];

      for (const [field, url] of Object.entries(fileUrls)) {
        const tipo = tipoMapping[field];
        console.log(`   💾 Salvo nel DB: ${tipo} -> ${url}`);
        
        const dbRes = await pool.query(
          `
          INSERT INTO documenti_autista 
            (autista_id, veicolo_id, tipo, url, stato, created_at)
          VALUES ($1, $2, $3, $4, 'pending', NOW())
          ON CONFLICT (autista_id, veicolo_id, tipo)
          DO UPDATE SET
            url = EXCLUDED.url,
            stato = 'pending',
            note_admin = NULL,
            created_at = NOW()
          RETURNING tipo
          `,
          [driver_id, veicolo_id, tipo, url]
        );

        if (dbRes.rows[0]) salvati.push(tipo);
      }

      await pool.query('COMMIT');
      await CacheManager.veicolo?.delete?.(veicolo_id);

      console.log(`🎉 [DOC_UPLOAD] Completato per veicolo ${veicolo_id}. Salvati: ${salvati.join(', ')}`);

      return res.json({
        success: true,
        message: 'Documenti aggiornati correttamente',
        salvati,
      });

    } catch (err) {
      if (err.message !== 'Nessun file è stato caricato...') {
         await pool.query('ROLLBACK');
      }
      console.error('💥 [DOC_UPLOAD] Errore critico:', err);
      return res.status(500).json({ success: false, message: err.message || 'Errore interno' });
    }
  }
);

/* ======================================================
   GET DOCUMENTI
====================================================== */
router.get('/:veicolo_id', authMiddleware, async (req, res) => {
  try {
    const driver_id = req.user.id;
    const veicolo_id = Number(req.params.veicolo_id);

    const result = await pool.query(
      `SELECT tipo, url FROM documenti_autista WHERE autista_id = $1 AND veicolo_id = $2`,
      [driver_id, veicolo_id]
    );

    const docs = { libretto: null, assicurazione: null, licenza_ncc: null };
    result.rows.forEach(r => { docs[r.tipo] = r.url; });

    return res.json(docs);
  } catch (err) {
    console.error('❌ ERRORE GET DOCUMENTI:', err);
    return res.status(500).json({ success: false, message: 'Errore caricamento documenti' });
  }
});

export default router;