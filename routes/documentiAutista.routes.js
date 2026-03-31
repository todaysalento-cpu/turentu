import { Router } from 'express';
import multer from 'multer';
import { pool } from '../db/db.js'; 
import { uploadFile } from '../helpers/cloudinary.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

const documentFields = [
  { name: 'foto_profilo', maxCount: 1 },
  { name: 'carta_identita', maxCount: 1 },
  { name: 'patente_foto', maxCount: 1 },
  { name: 'certificato_abilitazione', maxCount: 1 },
  { name: 'iscrizione_ruolo', maxCount: 1 },
];

// POST /api/autista/documenti/profilo
router.post('/profilo', upload.fields(documentFields), async (req, res) => {
  try {
    const {
      utente_id, // coerente con tabella utente
      nome_titolare_conto,
      numero_conto,
      nome_banca,
      ...rest
    } = req.body;

    // 🔹 Verifica utente esiste
    const userRes = await pool.query('SELECT id FROM utente WHERE id=$1', [utente_id]);
    if (!userRes.rows[0]) {
      return res.status(400).json({ success: false, message: 'Utente non trovato' });
    }

    // 🔹 Upload file su Cloudinary
    const fileUrls: Record<string, string> = {};
    for (const field of documentFields) {
      const file = req.files?.[field.name]?.[0];
      if (file) {
        const url = await uploadFile(file.buffer, file.originalname);
        if (url) fileUrls[field.name] = url;
      }
    }

    // 🔹 Inserimento documenti nel DB
    const documenti = Object.entries(fileUrls).map(([tipo, url]) => ({ tipo, url }));
    for (const doc of documenti) {
      await pool.query(
        'INSERT INTO documenti_autista (autista_id, tipo, url) VALUES ($1, $2, $3)',
        [utente_id, doc.tipo, doc.url]
      );
    }

    // 🔹 Aggiornamento dati bancari e tipo utente
    await pool.query(
      `UPDATE utente 
       SET nome_banca=$1, numero_conto=$2, nome_titolare_conto=$3, tipo='autista' 
       WHERE id=$4`,
      [nome_banca, numero_conto, nome_titolare_conto, utente_id]
    );

    return res.json({ success: true, message: 'Profilo e documenti salvati correttamente', fileUrls });
  } catch (err) {
    console.error('💥 Errore route /autista/documenti/profilo:', err);
    return res.status(500).json({ success: false, message: 'Errore interno' });
  }
});

export default router;