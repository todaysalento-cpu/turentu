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
        profilo: false,
        veicolo: false,
        disponibilita: false,
        tariffe: false
      });
    }

    const userId = req.user.id;

    console.log('👤 USER ID:', userId); // 🔥 DEBUG
    console.log('👤 USER OBJ:', req.user);

    // 🔹 PROFILO AUTISTA
    let profilo = false;
    try {
      const profiloResult = await pool.query(
        'SELECT * FROM autista_profilo WHERE utente_id = $1',
        [userId]
      );

      console.log('📄 PROFILO RESULT:', profiloResult.rows); // 🔥 DEBUG

      profilo = profiloResult.rowCount > 0;
    } catch (err) {
      console.error('Errore query profilo:', err.message);
    }

    // 🔹 VEICOLO
    let veicolo = false;
    try {
      const veicoloResult = await pool.query(
        'SELECT * FROM veicolo WHERE driver_id = $1',
        [userId]
      );

      console.log('🚗 VEICOLO RESULT:', veicoloResult.rows);

      veicolo = veicoloResult.rowCount > 0;
    } catch (err) {
      console.error('Errore query veicolo:', err.message);
    }

    // 🔹 DISPONIBILITÀ
    let disponibilita = false;
    try {
      const dispResult = await pool.query(
        `SELECT d.* FROM disponibilita_veicolo d
         JOIN veicolo v ON d.veicolo_id = v.id
         WHERE v.driver_id = $1`,
        [userId]
      );

      console.log('📅 DISP RESULT:', dispResult.rows);

      disponibilita = dispResult.rowCount > 0;
    } catch (err) {
      console.error('Errore query disponibilita:', err.message);
    }

    // 🔹 TARIFFE
    let tariffe = false;
    try {
      const tariffeResult = await pool.query(
        `SELECT t.* FROM tariffe t
         JOIN veicolo v ON t.veicolo_id = v.id
         WHERE v.driver_id = $1`,
        [userId]
      );

      console.log('💰 TARIFFE RESULT:', tariffeResult.rows);

      tariffe = tariffeResult.rowCount > 0;
    } catch (err) {
      console.error('Errore query tariffe:', err.message);
    }

    return res.json({ profilo, veicolo, disponibilita, tariffe });

  } catch (err) {
    console.error('Errore onboarding status:', err.message, err.stack);
    res.status(500).json({
      error: 'Errore server',
      profilo: false,
      veicolo: false,
      disponibilita: false,
      tariffe: false
    });
  }
});

export default router;