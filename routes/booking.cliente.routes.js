// routes/booking.cliente.routes.js
import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { pool } from '../db/db.js';

const router = express.Router();

// GET /booking/cliente/prenotazioni
router.get('/cliente/prenotazioni', authMiddleware, async (req, res) => {
  try {
    const clienteId = req.user.id;

    // 🔹 Prenotazioni confermate
    const prenotazioniRes = await pool.query(
      `SELECT 
         id, 
         corsa_id, 
         cliente_id, 
         posti_richiesti, 
         prezzo_totale
       FROM prenotazioni
       WHERE cliente_id=$1
       ORDER BY id DESC`,
      [clienteId]
    );

    // 🔹 Richieste pending
    const pendingRes = await pool.query(
      `SELECT 
         id, 
         veicolo_id, 
         cliente_id, 
         start_datetime, 
         posti_richiesti, 
         prezzo, 
         stato AS status, 
         corsa_id
       FROM pending
       WHERE cliente_id=$1
       ORDER BY start_datetime DESC`,
      [clienteId]
    );

    // 🔹 Normalizziamo i dati per il frontend
    const prenotazioni = prenotazioniRes.rows.map((p) => ({
      id: p.id,
      corsaId: p.corsa_id,
      clienteId: p.cliente_id,
      posti_richiesti: p.posti_richiesti,
      prezzo: Number(p.prezzo_totale || 0),
      status: 'confermata', // status fisso per prenotazioni confermate
    }));

    const pending = pendingRes.rows.map((p) => ({
      id: p.id,
      corsaId: p.corsa_id ?? null,
      clienteId: p.cliente_id,
      prezzo: Number(p.prezzo),
      status: p.status, // mappiamo stato -> status
      start_datetime: p.start_datetime,
      posti_richiesti: p.posti_richiesti,
      veicoloId: p.veicolo_id
    }));

    // 🔹 Risposta unificata
    res.json({ prenotazioni, pending });

  } catch (err) {
    console.error('❌ Fetch prenotazioni + pending error:', err);
    res.status(500).json({ message: 'Errore server' });
  }
});

export { router as bookingClienteRouter };