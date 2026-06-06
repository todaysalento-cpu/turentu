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
    const utente_id = req.user.id;
    
    // CORREZIONE: Recuperiamo le disponibilità filtrando per il driver_id del veicolo
    // Non usiamo getDisponibilita(utente_id) perché si aspetta un ID veicolo
    const query = `
      SELECT d.* FROM disponibilita_veicolo d
      JOIN veicolo v ON d.veicolo_id = v.id
      WHERE v.driver_id = $1
    `;
    
    const result = await pool.query(query, [utente_id]);
    
    console.log(`✅ [GET /disponibilita] Trovati ${result.rows.length} record per driver ${utente_id}`);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Disponibilità error:', err);
    res.status(500).json({ error: err.message });
  }
});

// -------------------- POST nuova disponibilità --------------------
router.post('/', async (req, res) => {
  try {
    const utente_id = req.user.id;
    const body = req.body;

    console.log('📥 POST /disponibilita body:', body);

    const { veicolo_id, start, fine, giorni_esclusi = [], inattivita = [] } = body;

    if (!veicolo_id || !start || !fine) {
      return res.status(400).json({ message: 'Dati mancanti' });
    }

    const veicolo = await pool.query(
      'SELECT id FROM veicolo WHERE id=$1 AND driver_id=$2',
      [veicolo_id, utente_id]
    );

    if (!veicolo.rows.length) {
      console.warn('⚠️ Veicolo non autorizzato', { veicolo_id, utente_id });
      return res.status(403).json({ message: 'Veicolo non autorizzato' });
    }

    const turno = await disponibilitaService.createDisponibilita({
      veicolo_id,
      start,
      fine,
      giorni_esclusi,
      inattivita,
    });

    console.log('✅ Disponibilità creata:', turno);
    res.json(turno);
  } catch (err) {
    console.error('❌ Creazione disponibilità error:', err);
    res.status(500).json({ error: err.message });
  }
});

// -------------------- PUT modifica disponibilità --------------------
router.put('/:id', async (req, res) => {
  try {
    const utente_id = req.user.id;
    const id = req.params.id;
    const { start, fine, giorni_esclusi = [], inattivita = [] } = req.body;

    const turno = await pool.query(
      `SELECT d.id 
       FROM disponibilita_veicolo d
       JOIN veicolo v ON v.id = d.veicolo_id
       WHERE d.id=$1 AND v.driver_id=$2`,
      [id, utente_id]
    );

    if (!turno.rows.length) {
      return res.status(403).json({ message: 'Non autorizzato' });
    }

    const updated = await disponibilitaService.updateDisponibilita(id, {
      start,
      fine,
      giorni_esclusi,
      inattivita,
    });

    console.log('✅ Disponibilità aggiornata:', updated);
    res.json(updated);
  } catch (err) {
    console.error('❌ Update disponibilità error:', err);
    res.status(500).json({ error: err.message });
  }
});

// -------------------- DELETE turno --------------------
router.delete/:id', async (req, res) => {
  try {
    const utente_id = req.user.id;
    const id = req.params.id;

    const turno = await pool.query(
      `SELECT d.id 
       FROM disponibilita_veicolo d
       JOIN veicolo v ON v.id = d.veicolo_id
       WHERE d.id=$1 AND v.driver_id=$2`,
      [id, utente_id]
    );

    if (!turno.rows.length) {
      return res.status(403).json({ message: 'Non autorizzato' });
    }

    await disponibilitaService.deleteDisponibilita(id);
    console.log('✅ Turno eliminato:', id);
    res.json({ message: 'Eliminato' });
  } catch (err) {
    console.error('❌ Delete disponibilità error:', err);
    res.status(500).json({ error: err.message });
  }
});

export { router as disponibilitaRouter };