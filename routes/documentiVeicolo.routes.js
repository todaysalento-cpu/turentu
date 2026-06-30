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

router.post(
  '/',
  authMiddleware,
  upload.fields(documentFields),
  async (req, res) => {
    const driver_id = req.user.id;
    const veicolo_id = Number(req.body.veicolo_id);

    console.log(`📥 UPLOAD DOC driver=${driver_id} veicolo=${veicolo_id}`);

    try {
      if (!veicolo_id) {
        return res.status(400).json({
          success: false,
          message: 'veicolo_id mancante'
        });
      }

      // ========================
      // CHECK VEICOLO
      // ========================
      const veicoloRes = await pool.query(
        'SELECT id FROM veicolo WHERE id=$1 AND driver_id=$2',
        [veicolo_id, driver_id]
      );

      if (veicoloRes.rowCount === 0) {
        return res.status(404).json({
          success: false,
          message: 'Veicolo non trovato'
        });
      }

      if (!req.files || Object.keys(req.files).length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Nessun file caricato'
        });
      }

      // ========================
      // UPLOAD CLOUDINARY
      // ========================
      const fileUrls = {};

      for (const field of documentFields) {
        const file = req.files?.[field.name]?.[0];
        if (!file) continue;

        try {
          const url = await uploadFile(file.buffer, file.originalname);
          if (url) {
            fileUrls[field.name] = url;
            console.log(`✅ ${field.name} -> ${url}`);
          }
        } catch (err) {
          console.error(`❌ Upload fail ${field.name}`, err);
        }
      }

      // ========================
      // DB TRANSACTION
      // ========================
      await pool.query('BEGIN');

      const salvati = [];

      for (const [field, url] of Object.entries(fileUrls)) {
        const tipo = tipoMapping[field];

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
          RETURNING *
          `,
          [driver_id, veicolo_id, tipo, url]
        );

        if (dbRes.rows[0]) salvati.push(tipo);
      }

      await pool.query('COMMIT');

      // ========================
      // CACHE INVALIDATION
      // ========================
      await CacheManager.veicolo?.delete?.(veicolo_id);

      console.log(`🎉 UPLOAD COMPLETATO:`, salvati);

      return res.json({
        success: true,
        message: 'Documenti aggiornati correttamente',
        salvati,
      });

    } catch (err) {
      await pool.query('ROLLBACK');
      console.error('💥 ERRORE UPLOAD DOC:', err);

      return res.status(500).json({
        success: false,
        message: 'Errore server upload documenti'
      });
    }
  }
);

export default router;