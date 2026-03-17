import express from 'express';
import { pool } from '../db/db.js';
import { authMiddleware } from '../middleware/auth.js';
import { io } from '../server.js';
import { prenotaCorsa } from '../services/prenotazione/prenotazione.service.js';
import { createCorsaFromPending } from '../services/corsa/corsa.service.js';

const router = express.Router();
router.use(authMiddleware);

// -------------------- GET pending di un veicolo (autista) --------------------
router.get('/autista/:veicoloId', async (req, res) => {
  const client = await pool.connect();
  try {
    const veicoloId = Number(req.params.veicoloId);

    const result = await client.query(
      `SELECT *, 
              ST_X(origine::geometry) AS origine_lon,
              ST_Y(origine::geometry) AS origine_lat,
              ST_X(destinazione::geometry) AS destinazione_lon,
              ST_Y(destinazione::geometry) AS destinazione_lat
       FROM pending
       WHERE veicolo_id = $1 
       AND stato <> 'accettata'
       ORDER BY id ASC`,
      [veicoloId]
    );

    const pendings = result.rows.map(p => ({
      ...p,
      origine: {
        lat: p.origine_lat !== null ? Number(p.origine_lat) : null,
        lon: p.origine_lon !== null ? Number(p.origine_lon) : null,
      },
      destinazione: {
        lat: p.destinazione_lat !== null ? Number(p.destinazione_lat) : null,
        lon: p.destinazione_lon !== null ? Number(p.destinazione_lon) : null,
      },
      origine_address: p.origine_address || 'N/D',
      destinazione_address: p.destinazione_address || 'N/D',
      prezzo: Number(p.prezzo),
    }));

    res.json({ pendings });
  } catch (err) {
    console.error('❌ Error fetching pendings:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// -------------------- POST accetta pending --------------------
router.post('/:id/accetta', async (req, res) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    const { allSlots = false } = req.body;

    await client.query('BEGIN');

    const pendingRes = await client.query(
      'SELECT * FROM pending WHERE id = $1 FOR UPDATE',
      [id]
    );

    if (!pendingRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Pending non trovato' });
    }

    let acceptedPendings = [];

    if (allSlots && pendingRes.rows[0].request_id) {
      const result = await client.query(
        `UPDATE pending 
         SET stato = 'accettata'
         WHERE request_id = $1
         RETURNING *, 
                   ST_X(origine::geometry) AS origine_lon,
                   ST_Y(origine::geometry) AS origine_lat,
                   ST_X(destinazione::geometry) AS destinazione_lon,
                   ST_Y(destinazione::geometry) AS destinazione_lat`,
        [pendingRes.rows[0].request_id]
      );
      acceptedPendings = result.rows;
    } else {
      const result = await client.query(
        `UPDATE pending 
         SET stato = 'accettata'
         WHERE id = $1
         RETURNING *, 
                   ST_X(origine::geometry) AS origine_lon,
                   ST_Y(origine::geometry) AS origine_lat,
                   ST_X(destinazione::geometry) AS destinazione_lon,
                   ST_Y(destinazione::geometry) AS destinazione_lat`,
        [id]
      );
      acceptedPendings = result.rows;
    }

    // Normalizzazione con campi corretti
    acceptedPendings = acceptedPendings.map(p => ({
      ...p,
      origine: {
        lat: p.origine_lat !== null ? Number(p.origine_lat) : null,
        lon: p.origine_lon !== null ? Number(p.origine_lon) : null,
      },
      destinazione: {
        lat: p.destinazione_lat !== null ? Number(p.destinazione_lat) : null,
        lon: p.destinazione_lon !== null ? Number(p.destinazione_lon) : null,
      },
      origine_address: p.origine_address || 'N/D',
      destinazione_address: p.destinazione_address || 'N/D',
      prezzo: Number(p.prezzo),
    }));

    let prenotazioni = [];

    for (const p of acceptedPendings) {
      let corsa, prenotazione;

      if (!p.corsa_id) {
        const veicolo = { id: p.veicolo_id, posti: 4 };
        const corsaResult = await createCorsaFromPending(p, veicolo, client);
        corsa = corsaResult.corsa;
        prenotazione = corsaResult.prenotazione;

        await client.query(
          `UPDATE pending SET corsa_id = $1 WHERE id = $2`,
          [corsa.id, p.id]
        );

        prenotazioni.push(prenotazione);
      } else {
        const corsaRes = await client.query(
          `SELECT * FROM corse WHERE id = $1`,
          [p.corsa_id]
        );
        if (!corsaRes.rows.length) throw new Error('Corsa non trovata');

        corsa = corsaRes.rows[0];
        const pren = await prenotaCorsa(corsa, p.cliente_id, p.posti_richiesti, client);
        prenotazioni.push(pren);
      }
    }

    await client.query('COMMIT');

    // -------------------- SOCKET --------------------
    for (const p of acceptedPendings) {
      const payload = {
        id: p.id,
        stato: 'accettata',
        origine: p.origine,
        destinazione: p.destinazione,
        origine_address: p.origine_address,
        destinazione_address: p.destinazione_address,
        prezzo: p.prezzo,
        posti_richiesti: p.posti_richiesti,
        corsa_id: p.corsa_id,
      };

      io.to(`autista_${p.veicolo_id}`).emit('pending_update', payload);
      io.to(`cliente_${p.cliente_id}`).emit(
        'prenotazione_creata',
        prenotazioni.find(pr => pr.cliente_id === p.cliente_id)
      );
    }

    res.json({ pendings: acceptedPendings, prenotazioni });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Pending accept error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

export { router as pendingRouter };
