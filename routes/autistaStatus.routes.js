// routes/autistaStatus.routes.js
import { Router } from 'express';
import { pool } from '../db/db.js';
import { authMiddleware } from '../middleware/auth.js';

const router = Router();

router.get('/status', authMiddleware, async (req, res) => {
  try {
    if (!req.user || !req.user.id) {
      return res.status(401).json({
        error: 'Utente non autenticato',
        profilo: null,
        veicolo: null,
        disponibilita: null,
        tariffe: []
      });
    }

    const userId = req.user.id;

    // 🔹 PROFILO AUTISTA
    let profilo = null;
    try {
      const resP = await pool.query('SELECT * FROM autista_profilo WHERE utente_id = $1', [userId]);
      profilo = resP.rowCount > 0 ? resP.rows[0] : null;
    } catch (err) {
      console.error('Errore query profilo:', err.message);
    }

    // 🔹 VEICOLO
    let veicolo = null;
    try {
      const resV = await pool.query('SELECT * FROM veicolo WHERE driver_id = $1 LIMIT 1', [userId]);
      veicolo = resV.rowCount > 0 ? resV.rows[0] : null;
    } catch (err) {
      console.error('Errore query veicolo:', err.message);
    }

    // 🔹 DISPONIBILITÀ
    let disponibilita = null;
    try {
      const resD = await pool.query(
        `SELECT d.* FROM disponibilita_veicolo d
         JOIN veicolo v ON d.veicolo_id = v.id
         WHERE v.driver_id = $1 LIMIT 1`,
        [userId]
      );
      disponibilita = resD.rowCount > 0 ? resD.rows[0] : null;
    } catch (err) {
      console.error('Errore query disponibilita:', err.message);
    }

    // 🔹 TARIFFE
    let tariffe = [];
    try {
      const resT = await pool.query(
        `SELECT t.* FROM tariffe t
         JOIN veicolo v ON t.veicolo_id = v.id
         WHERE v.driver_id = $1`,
        [userId]
      );
      tariffe = resT.rows; // Array di tariffe
    } catch (err) {
      console.error('Errore query tariffe:', err.message);
    }

    // Risposta con dati strutturati (se mancano, i campi saranno null/[])
    return res.json({ profilo, veicolo, disponibilita, tariffe });

  } catch (err) {
    console.error('Errore onboarding status:', err.message);
    res.status(500).json({
      error: 'Errore server',
      profilo: null,
      veicolo: null,
      disponibilita: null,
      tariffe: []
    });
  }
});

export default router;