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
    const disponibilita = await disponibilitaService.getDisponibilita(utente_id);
    res.json(disponibilita);
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
    console.log('📥 Utente:', utente_id);

    const { veicolo_id, start, fine, giorni_esclusi = [], inattivita = [] } = body;

    if (!veicolo_id || !start || !fine) {
      console.warn('⚠️ Dati mancanti:', { veicolo_id, start, fine });
      return res.status(400).json({ message: 'Dati mancanti' });
    }

    // ✅ driver_id al posto di utente_id
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
    const body = req.body;

    console.log('📥 PUT /disponibilita/:id', { id, body, utente_id });

    const { start, fine, giorni_esclusi = [], inattivita = [] } = body;

    // ✅ driver_id al posto di utente_id
    const turno = await pool.query(
      `SELECT d.id 
       FROM disponibilita_veicolo d
       JOIN veicolo v ON v.id = d.veicolo_id
       WHERE d.id=$1 AND v.driver_id=$2`,
      [id, utente_id]
    );

    if (!turno.rows.length) {
      console.warn('⚠️ Non autorizzato a modificare turno', { id, utente_id });
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
router.delete('/:id', async (req, res) => {
  try {
    const utente_id = req.user.id;
    const id = req.params.id;

    console.log('📥 DELETE /disponibilita/:id', { id, utente_id });

    // ✅ driver_id al posto di utente_id
    const turno = await pool.query(
      `SELECT d.id 
       FROM disponibilita_veicolo d
       JOIN veicolo v ON v.id = d.veicolo_id
       WHERE d.id=$1 AND v.driver_id=$2`,
      [id, utente_id]
    );

    if (!turno.rows.length) {
      console.warn('⚠️ Non autorizzato a cancellare turno', { id, utente_id });
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