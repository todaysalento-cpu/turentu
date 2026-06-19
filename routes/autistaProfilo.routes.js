import { Router } from 'express';
import { pool } from '../db/db.js';
import { authMiddleware } from '../middleware/auth.js';
import multer from 'multer';
import { uploadFile } from '../helpers/cloudinary.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

const TIPO_DOCUMENTO_MAP = {
  foto_profilo: 'foto_profilo',
  carta_identita: 'carta_identita',
  patente: 'patente',
  certificato_abilitazione: 'certificato_abilitazione',
  iscrizione_ruolo: 'iscrizione_ruolo',
  licenza_ncc: 'licenza_ncc',
  assicurazione: 'assicurazione',
  libretto: 'libretto',
};

// ===================== POST PROFILO =====================
router.post('/', authMiddleware, upload.any(), async (req, res) => {
  try {
    const utente_id = req.user.id;
    const { nome, cognome, telefono, iban, nome_titolare_conto, nome_banca } = req.body;

    if (!nome || !cognome || !telefono || !iban || !nome_titolare_conto || !nome_banca) {
      return res.status(400).json({ success: false, message: 'Campi obbligatori mancanti' });
    }

    // 1. Gestione Profilo (Logica check-then-act)
    const checkRes = await pool.query('SELECT id FROM autista_profilo WHERE utente_id = $1 LIMIT 1', [utente_id]);
    let profileId;

    if (checkRes.rowCount > 0) {
      profileId = checkRes.rows[0].id;
      await pool.query(
        `UPDATE autista_profilo SET nome=$1, cognome=$2, telefono=$3, iban=$4, nome_titolare_conto=$5, nome_banca=$6, updated_at=NOW() WHERE id=$7`,
        [nome, cognome, telefono, iban, nome_titolare_conto, nome_banca, profileId]
      );
    } else {
      const insRes = await pool.query(
        `INSERT INTO autista_profilo (utente_id, nome, cognome, telefono, iban, nome_titolare_conto, nome_banca, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW()) RETURNING id`,
        [utente_id, nome, cognome, telefono, iban, nome_titolare_conto, nome_banca]
      );
      profileId = insRes.rows[0].id;
    }

    // 2. Elaborazione File
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const url = await uploadFile(file.buffer, file.originalname);
        if (!url) continue;

        if (file.fieldname === 'foto_profilo') {
          await pool.query(`UPDATE autista_profilo SET foto_profilo = $1 WHERE id = $2`, [url, profileId]);
        } else if (TIPO_DOCUMENTO_MAP[file.fieldname]) {
          const tipo = TIPO_DOCUMENTO_MAP[file.fieldname];
          
          // Verifica se esiste già il documento per evitare ON CONFLICT
          const docCheck = await pool.query('SELECT id FROM documenti_autista WHERE autista_id = $1 AND tipo = $2', [utente_id, tipo]);
          
          if (docCheck.rowCount > 0) {
            await pool.query('UPDATE documenti_autista SET url = $1, stato = $2 WHERE id = $3', [url, 'pending', docCheck.rows[0].id]);
          } else {
            await pool.query('INSERT INTO documenti_autista (autista_id, tipo, url, stato) VALUES ($1, $2, $3, $4)', [utente_id, tipo, url, 'pending']);
          }
        }
      }
    }

    res.json({ success: true, message: 'Profilo salvato correttamente' });
  } catch (err) {
    console.error('❌ Errore POST /autista/profilo:', err);
    res.status(500).json({ success: false, message: 'Errore interno server' });
  }
});

// ===================== GET PROFILO =====================
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const utente_id = req.user.id;
    const [profiloRes, docRes] = await Promise.all([
      pool.query('SELECT * FROM autista_profilo WHERE utente_id = $1 ORDER BY id DESC LIMIT 1', [utente_id]),
      pool.query('SELECT tipo, url FROM documenti_autista WHERE autista_id = $1', [utente_id])
    ]);

    const profilo = profiloRes.rows[0] || null;
    const documenti = {};
    docRes.rows.forEach(({ tipo, url }) => {
      const frontendKey = Object.keys(TIPO_DOCUMENTO_MAP).find(key => TIPO_DOCUMENTO_MAP[key] === tipo) || tipo;
      documenti[frontendKey] = url;
    });

    res.json({ success: true, data: profilo ? { ...profilo, documenti } : null });
  } catch (err) {
    console.error('❌ Errore GET /autista/profilo/me:', err);
    res.status(500).json({ success: false, message: 'Errore interno server' });
  }
});

export default router;