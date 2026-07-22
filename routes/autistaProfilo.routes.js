import { Router } from 'express';
import { pool } from '../db/db.js';
import { authMiddleware } from '../middleware/auth.js';
import { uploadFile } from '../helpers/cloudinary.js';

const router = Router();

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

// Funzione di utilità per convertire il Base64 in Buffer per Cloudinary
const base64ToBuffer = (base64String) => {
  const base64Data = base64String.replace(/^data:([A-Za-z-+/]+);base64,/, '');
  return Buffer.from(base64Data, 'base64');
};

// ===================== POST PROFILO =====================
router.post('/', authMiddleware, async (req, res) => {
  try {
    const utente_id = req.user.id;
    const { nome, cognome, telefono, iban, nome_titolare_conto, nome_banca, foto_profilo, documenti } = req.body;

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

    // 2. Elaborazione Foto Profilo (se inviata in Base64)
    if (foto_profilo && foto_profilo.startsWith('data:image')) {
      const buffer = base64ToBuffer(foto_profilo);
      const url = await uploadFile(buffer, 'foto_profilo.jpg');
      if (url) {
        await pool.query(`UPDATE autista_profilo SET foto_profilo = $1 WHERE id = $2`, [url, profileId]);
      }
    }

    // 3. Elaborazione Documenti (se inviati in Base64)
    if (documenti && typeof documenti === 'object') {
      for (const [key, uri] of Object.entries(documenti)) {
        if (uri && uri.startsWith('data:image') && TIPO_DOCUMENTO_MAP[key]) {
          const tipo = TIPO_DOCUMENTO_MAP[key];
          const buffer = base64ToBuffer(uri);
          const url = await uploadFile(buffer, `${key}.jpg`);
          
          if (!url) continue;

          // CORRETTO: Usiamo profileId (o utente_id in base a come è strutturato il tuo DB, 
          // ma legarlo a profileId risolve il disallineamento)
          const docCheck = await pool.query('SELECT id FROM documenti_autista WHERE autista_id = $1 AND tipo = $2', [profileId, tipo]);
          
          if (docCheck.rowCount > 0) {
            await pool.query('UPDATE documenti_autista SET url = $1, stato = $2 WHERE id = $3', [url, 'pending', docCheck.rows[0].id]);
          } else {
            await pool.query('INSERT INTO documenti_autista (autista_id, tipo, url, stato) VALUES ($1, $2, $3, $4)', [profileId, tipo, url, 'pending']);
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
    
    // Recuperiamo prima il profilo per avere il suo ID corretto
    const profiloRes = await pool.query('SELECT * FROM autista_profilo WHERE utente_id = $1 ORDER BY id DESC LIMIT 1', [utente_id]);
    const profilo = profiloRes.rows[0] || null;

    let documenti = {};
    if (profilo) {
      // Usiamo profileId per recuperare i documenti collegati a questo autista
      const docRes = await pool.query('SELECT tipo, url FROM documenti_autista WHERE autista_id = $1', [profilo.id]);
      docRes.rows.forEach(({ tipo, url }) => {
        const frontendKey = Object.keys(TIPO_DOCUMENTO_MAP).find(key => TIPO_DOCUMENTO_MAP[key] === tipo) || tipo;
        documenti[frontendKey] = url;
      });
    }

    res.json({ success: true, data: profilo ? { ...profilo, documenti } : null });
  } catch (err) {
    console.error('❌ Errore GET /autista/profilo/me:', err);
    res.status(500).json({ status: false, message: 'Errore interno server' });
  }
});

export default router;