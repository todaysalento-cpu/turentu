import { Router } from 'express';
import multer from 'multer';
import { pool } from '../db/db.js';
import { uploadFile } from '../helpers/cloudinary.js';
import { authMiddleware } from '../middleware/auth.js';

const router = Router();

// Configurazione multer
const upload = multer({ storage: multer.memoryStorage() });

// Campi documenti
const documentFields = [
  { name: 'foto_profilo', maxCount: 1 },
  { name: 'carta_identita', maxCount: 1 },
  { name: 'patente_foto', maxCount: 1 },
  { name: 'certificato_abilitazione', maxCount: 1 },
  { name: 'iscrizione_ruolo', maxCount: 1 },
];

// ✅ Mapping corretto (JS puro)
const tipoMapping = {
  foto_profilo: 'foto_profilo',
  carta_identita: 'carta_identita',
  patente_foto: 'patente',
  certificato_abilitazione: 'certificato_abilitazione',
  iscrizione_ruolo: 'iscrizione_ruolo',
};

router.post(
  '/profilo',
  authMiddleware,
  upload.fields(documentFields),
  async (req, res) => {
    try {
      const utente_id = req.user.id;

      const {
        nome,
        cognome,
        codice_fiscale,
        patente,
        certificato_ncc,
        iban,
        telefono,
      } = req.body;

      // 🔹 Controllo utente
      const userRes = await pool.query(
        'SELECT id FROM utente WHERE id=$1',
        [utente_id]
      );

      if (!userRes.rows[0]) {
        return res.status(400).json({
          success: false,
          message: 'Utente non trovato',
        });
      }

      // 🔹 Upload file
      const fileUrls = {}; // ✅ JS puro

      for (const field of documentFields) {
        const file = req.files?.[field.name]?.[0];

        if (file) {
          const url = await uploadFile(file.buffer, file.originalname);
          if (url) fileUrls[field.name] = url;
        }
      }

      // 🔹 Salvataggio profilo
      await pool.query(
        `INSERT INTO autista_profilo
        (utente_id, nome, cognome, codice_fiscale, patente, certificato_ncc, iban, telefono, foto_profilo, documenti, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now(), now())
        ON CONFLICT (utente_id)
        DO UPDATE SET
          nome = $2,
          cognome = $3,
          codice_fiscale = $4,
          patente = $5,
          certificato_ncc = $6,
          iban = $7,
          telefono = $8,
          foto_profilo = $9,
          documenti = $10,
          updated_at = now()`,
        [
          utente_id,
          nome,
          cognome,
          codice_fiscale,
          patente,
          certificato_ncc === 'true' || certificato_ncc === true,
          iban,
          telefono,
          fileUrls['foto_profilo'] || null,
          JSON.stringify({
            carta_identita: fileUrls['carta_identita'] || null,
            patente_foto: fileUrls['patente_foto'] || null,
            certificato_abilitazione: fileUrls['certificato_abilitazione'] || null,
            iscrizione_ruolo: fileUrls['iscrizione_ruolo'] || null,
          }),
        ]
      );

      // 🔹 Inserimento documenti con mapping corretto
      for (const [field, url] of Object.entries(fileUrls)) {
        if (field !== 'foto_profilo' && url) {
          const tipoDB = tipoMapping[field];

          // sicurezza extra
          if (!tipoDB) continue;

          await pool.query(
            `INSERT INTO documenti_autista (autista_id, tipo, url)
             VALUES ($1,$2,$3)
             ON CONFLICT DO NOTHING`,
            [utente_id, tipoDB, url]
          );
        }
      }

      return res.json({
        success: true,
        message: 'Profilo e documenti salvati correttamente',
        fileUrls,
      });

    } catch (err) {
      console.error('💥 Errore route /autista/documenti/profilo:', err);
      return res.status(500).json({
        success: false,
        message: 'Errore interno server',
      });
    }
  }
);

export default router;