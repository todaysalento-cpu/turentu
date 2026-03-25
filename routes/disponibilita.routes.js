// ======================= routes/disponibilita.routes.js =======================
import express from 'express';
import { pool } from '../db/db.js';
import * as disponibilitaService from '../services/search/disponibilita/disponibilita.service.js';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();

// Tutte le rotte richiedono login
router.use(authMiddleware);

// -------------------- GET disponibilità autista --------------------
router.get('/', async (req, res) => {
  try {
    const driver_id = req.user.id;
    const disponibilita = await disponibilitaService.getDisponibilita(driver_id);
    res.json(disponibilita);
  } catch (err) {
    console.error('❌ Disponibilità error:', err);
    res.status(500).json({ error: err.message });
  }
});

// -------------------- POST nuova disponibilità --------------------
router.post('/', async (req, res) => {
  try {
    const driver_id = req.user.id;
    const { veicolo_id, start, fine, giorni_esclusi = [], inattivita = [] } = req.body;

    // Controlla che il veicolo appartenga all'autista
    const veicolo = await pool.query(
      'SELECT * FROM veicolo WHERE id=$1 AND driver_id=$2',
      [veicolo_id, driver_id]
    );
    if (!veicolo.rows.length) return res.status(403).json({ message: 'Veicolo non autorizzato' });

    // Passa giorni_esclusi come array e inattivita come JSONB
    const turno = await disponibilitaService.createDisponibilita({
      veicolo_id,
      start,
      fine,
      giorni_esclusi,
      inattivita,
    });

    res.json(turno);
  } catch (err) {
    console.error('❌ Creazione disponibilità error:', err);
    res.status(500).json({ error: err.message });
  }
});

// -------------------- PUT modifica disponibilità --------------------
router.put('/:id', async (req, res) => {
  try {
    const driver_id = req.user.id;
    const id = req.params.id;
    const { veicolo_id, start, fine, giorni_esclusi = [], inattivita = [] } = req.body;

    // Controlla che il turno appartenga a un veicolo dell'autista
    const turno = await pool.query(
      `SELECT d.* FROM disponibilita_veicolo d 
       JOIN veicolo v ON v.id = d.veicolo_id
       WHERE d.id=$1 AND v.driver_id=$2`,
      [id, driver_id]
    );
    if (!turno.rows.length) return res.status(403).json({ message: 'Non autorizzato' });

    // Aggiorna con array e JSONB
    const updated = await disponibilitaService.updateDisponibilita(id, {
      start,
      fine,
      giorni_esclusi,
      inattivita,
    });

    res.json(updated);
  } catch (err) {
    console.error('❌ Update disponibilità error:', err);
    res.status(500).json({ error: err.message });
  }
});

// -------------------- DELETE turno --------------------
router.delete('/:id', async (req, res) => {
  try {
    const driver_id = req.user.id;
    const id = req.params.id;

    const turno = await pool.query(
      `SELECT d.* FROM disponibilita_veicolo d 
       JOIN veicolo v ON v.id = d.veicolo_id
       WHERE d.id=$1 AND v.driver_id=$2`,
      [id, driver_id]
    );
    if (!turno.rows.length) return res.status(403).json({ message: 'Non autorizzato' });

    await disponibilitaService.deleteDisponibilita(id);
    res.json({ message: 'Eliminato' });
  } catch (err) {
    console.error('❌ Delete disponibilità error:', err);
    res.status(500).json({ error: err.message });
  }
});

export { router as disponibilitaRouter };