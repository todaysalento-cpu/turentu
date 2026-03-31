// ======================= routes/documentiAutista.routes.js =======================
import { Router } from 'express';
import multer from 'multer';
import { db } from '../db/db.js';
import { uploadFile } from '../helpers/cloudinary.js';

const router = Router();

// Configurazione multer (memory storage per buffer)
const upload = multer({ storage: multer.memoryStorage() });

// 🔹 Campi attesi come file dal frontend
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
      autista_id,
      nome_titolare_conto,
      numero_conto,
      nome_banca,
      ...rest
    } = req.body;

    // 🔹 Verifica utente esiste e tipo autista
    const userRes = await db.query('SELECT tipo FROM utente WHERE id=$1', [autista_id]);
    if (!userRes.rows[0] || userRes.rows[0].tipo !== 'autista') {
      return res.status(400).json({ success: false, message: 'Utente non è autista' });
    }

    // 🔹 Upload file su Cloudinary
    const fileUrls = {};
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
      await db.query(
        'INSERT INTO documenti_autista (autista_id, tipo, url) VALUES ($1, $2, $3)',
        [autista_id, doc.tipo, doc.url]
      );
    }

    // 🔹 Aggiornamento dati bancari
    await db.query(
      'UPDATE utente SET nome_banca=$1, numero_conto=$2, nome_titolare_conto=$3 WHERE id=$4',
      [nome_banca, numero_conto, nome_titolare_conto, autista_id]
    );

    return res.json({ success: true, message: 'Profilo e documenti salvati correttamente', fileUrls });
  } catch (err) {
    console.error('💥 Errore route /autista/documenti/profilo:', err);
    return res.status(500).json({ success: false, message: 'Errore interno' });
  }
});

export default router;