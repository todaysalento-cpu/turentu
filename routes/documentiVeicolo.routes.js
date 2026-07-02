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
   HELPER: Recupero dati (Include URL e STATO)
====================================================== */
async function getDocumentiData(driver_id, veicolo_id) {
  const result = await pool.query(
    'SELECT tipo, url, stato FROM documenti_autista WHERE autista_id = $1 AND veicolo_id = $2',
    [driver_id, veicolo_id]
  );
  
  const docs = { 
    libretto: null, 
    assicurazione: null, 
    licenza_ncc: null 
  };
  
  result.rows.forEach(r => { 
    docs[r.tipo] = {
      url: r.url,
      stato: r.stato
    }; 
  });
  
  return docs;
}

/* ======================================================
   UPLOAD DOCUMENTI
====================================================== */
router.post('/', authMiddleware, upload.fields(documentFields), async (req, res) => {
  const driver_id = req.user.id;
  const veicolo_id = Number(req.body.veicolo_id);

  if (!veicolo_id) return res.status(400).json({ success: false, message: 'veicolo_id mancante' });
  if (!req.files || Object.keys(req.files).length === 0) {
    return res.status(400).json({ success: false, message: 'Nessun file caricato' });
  }

  try {
    // 1. Verifica autorizzazione
    const veicoloRes = await pool.query('SELECT id FROM veicolo WHERE id=$1 AND driver_id=$2', [veicolo_id, driver_id]);
    if (veicoloRes.rowCount === 0) return res.status(404).json({ success: false, message: 'Veicolo non trovato' });

    // 2. Upload su Cloudinary
    const fileUrls = {};
    for (const field of documentFields) {
      const file = req.files[field.name]?.[0];
      if (file) {
        const url = await uploadFile(file.buffer, file.originalname);
        if (url) fileUrls[field.name] = url;
      }
    }

    if (Object.keys(fileUrls).length === 0) throw new Error('Upload fallito su Cloudinary');

    // 3. Salva nel DB (Transazione)
    await pool.query('BEGIN');
    for (const [field, url] of Object.entries(fileUrls)) {
      await pool.query(
        `INSERT INTO documenti_autista (autista_id, veicolo_id, tipo, url, stato, created_at)
         VALUES ($1, $2, $3, $4, 'pending', NOW())
         ON CONFLICT (autista_id, veicolo_id, tipo)
         DO UPDATE SET 
            url = EXCLUDED.url, 
            stato = 'pending', 
            created_at = NOW()`,
        [driver_id, veicolo_id, tipoMapping[field], url]
      );
    }
    await pool.query('COMMIT');

    // 4. Invalida cache e recupera stato aggiornato
    await CacheManager.veicolo?.delete?.(veicolo_id);
    
    const updatedDocs = await getDocumentiData(driver_id, veicolo_id);

    return res.json({
      success: true,
      documenti: updatedDocs
    });

  } catch (err) {
    await pool.query('ROLLBACK');
    console.error('💥 [DOC_UPLOAD_ERROR]:', err);
    return res.status(500).json({ success: false, message: 'Errore durante il salvataggio dei documenti' });
  }
});

/* ======================================================
   GET DOCUMENTI
====================================================== */
router.get('/:veicolo_id', authMiddleware, async (req, res) => {
  try {
    const docs = await getDocumentiData(req.user.id, Number(req.params.veicolo_id));
    return res.json(docs);
  } catch (err) {
    console.error('💥 [GET_DOC_ERROR]:', err);
    return res.status(500).json({ success: false, message: 'Errore recupero documenti' });
  }
});

export default router;