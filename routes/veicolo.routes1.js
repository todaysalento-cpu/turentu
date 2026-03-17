// routes/veicolo.routes.js
import express from 'express';
import { pool } from '../db/db.js';
import { authMiddleware } from '../middleware/auth.js';

export const veicoloRouter = express.Router();
veicoloRouter.use(authMiddleware);

// GET tutti i veicoli dell'autista loggato
veicoloRouter.get('/', async (req, res) => {
  try {
    const driver_id = req.user.id;
    const result = await pool.query(
      'SELECT * FROM veicolo WHERE driver_id=$1 ORDER BY id DESC',
      [driver_id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Veicoli GET error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST nuovo veicolo
veicoloRouter.post('/', async (req, res) => {
  try {
    const driver_id = req.user.id;
    const { modello, posti_totali, euro_km, raggio_km, targa, prezzo_passeggero, servizi } = req.body;

    const result = await pool.query(
      `INSERT INTO veicolo
        (driver_id, modello, posti_totali, euro_km, raggio_km, targa, prezzo_passeggero, servizi)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [driver_id, modello, posti_totali, euro_km, raggio_km, targa, prezzo_passeggero, servizi]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Veicoli POST error:', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE veicolo
veicoloRouter.delete('/:id', async (req, res) => {
  try {
    const driver_id = req.user.id;
    const veicolo_id = Number(req.params.id);

    const result = await pool.query(
      'DELETE FROM veicolo WHERE id=$1 AND driver_id=$2 RETURNING *',
      [veicolo_id, driver_id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: 'Veicolo non trovato o non autorizzato' });
    }

    res.json({ message: 'Veicolo eliminato ✅' });
  } catch (err) {
    console.error('❌ Veicoli DELETE error:', err);
    res.status(500).json({ error: err.message });
  }
});
