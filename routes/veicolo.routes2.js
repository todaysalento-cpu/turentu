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
    const { modello, posti_totali, raggio_km, targa, servizi } = req.body;

    const result = await pool.query(
      `INSERT INTO veicolo
        (driver_id, modello, posti_totali, raggio_km, targa, servizi)
       VALUES ($1,$2,$3,$4,$5,$6::json)
       RETURNING *`,
      [driver_id, modello, posti_totali, raggio_km, targa, JSON.stringify(servizi)]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Veicoli POST error:', err);

    if (err.code === '23505' && err.constraint === 'veicolo_targa_key') {
      return res.status(400).json({ error: 'Targa già utilizzata da un altro veicolo' });
    }

    res.status(500).json({ error: err.message });
  }
});

// PUT aggiorna veicolo
veicoloRouter.put('/:id', async (req, res) => {
  try {
    const driver_id = req.user.id;
    const veicolo_id = Number(req.params.id);
    const { modello, posti_totali, raggio_km, targa, servizi } = req.body;

    const result = await pool.query(
      `UPDATE veicolo
       SET modello=$1,
           posti_totali=$2,
           raggio_km=$3,
           targa=$4,
           servizi=$5::json
       WHERE id=$6 AND driver_id=$7
       RETURNING *`,
      [modello, posti_totali, raggio_km, targa, JSON.stringify(servizi), veicolo_id, driver_id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: 'Veicolo non trovato o non autorizzato' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Veicolo PUT error:', err);

    if (err.code === '23505' && err.constraint === 'veicolo_targa_key') {
      return res.status(400).json({ error: 'Targa già utilizzata da un altro veicolo' });
    }

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
