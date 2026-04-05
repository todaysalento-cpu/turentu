import { Router } from 'express';
import { pool } from '../db/db.js';
import { authMiddleware } from '../middleware/auth.js';
import multer from 'multer';
import { uploadFile } from '../helpers/cloudinary.js'; // funzione che carica buffer e restituisce URL

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

router.post(
  '/',
  authMiddleware,
  upload.single('foto_profilo'),
  async (req, res) => {
    try {
      const utente_id = req.user.id;
      const { nome, cognome, telefono, iban, nome_titolare_conto, nome_banca } = req.body;

      if (!nome || !cognome || !telefono || !iban || !nome_titolare_conto || !nome_banca) {
        return res.status(400).json({ success: false, message: 'Campi obbligatori mancanti' });
      }

      let foto_profilo_url = null;
      if (req.file) {
        foto_profilo_url = await uploadFile(req.file.buffer, req.file.originalname);
      }

      const query = `
        INSERT INTO autista_profilo
          (utente_id, nome, cognome, telefono, iban, nome_titolare_conto, nome_banca, foto_profilo, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8, NOW(), NOW())
        ON CONFLICT (utente_id)
        DO UPDATE SET
          nome = $2,
          cognome = $3,
          telefono = $4,
          iban = $5,
          nome_titolare_conto = $6,
          nome_banca = $7,
          foto_profilo = $8,
          updated_at = NOW()
        RETURNING *;
      `;

      const values = [
        utente_id,
        nome,
        cognome,
        telefono,
        iban,
        nome_titolare_conto,
        nome_banca,
        foto_profilo_url,
      ];

      const result = await pool.query(query, values);
      res.json({ success: true, data: result.rows[0] });
    } catch (err) {
      console.error('❌ Errore /autista/profilo POST:', err);
      res.status(500).json({ success: false, message: 'Errore interno server' });
    }
  }
);

export default router;