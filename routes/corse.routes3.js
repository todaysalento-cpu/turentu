import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { getCorseByAutista, accettaCorsa } from '../services/corsa/corse.service.js';
import { getAddress } from '../utils/geo.util.js';
import { pool } from '../db/db.js';

export const corseRouter = express.Router();
corseRouter.use(authMiddleware);

// ----------------------
// 1️⃣ Tutte le corse non completate dell'autista
// ----------------------
corseRouter.get('/autista/:id', async (req, res) => {
  try {
    const status = req.query.status || '';
    let corse = await getCorseByAutista(Number(req.params.id), status);

    corse = await Promise.all(corse.map(async c => {
      const origineAddress = c.origine ? await getAddress(c.origine) : 'N/D';
      const destinazioneAddress = c.destinazione ? await getAddress(c.destinazione) : 'N/D';
      return { ...c, origineAddress, destinazioneAddress };
    }));

    res.json(corse);
  } catch (err) {
    console.error('Errore GET /autista/:id', err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------
// 2️⃣ Corse della giornata (pagina Live)
// ----------------------
corseRouter.get('/autista/today/:id', async (req, res) => {
  try {
    let corse = await getCorseByAutista(Number(req.params.id), 'today');

    corse = await Promise.all(corse.map(async c => {
      const origineAddress = c.origine ? await getAddress(c.origine) : 'N/D';
      const destinazioneAddress = c.destinazione ? await getAddress(c.destinazione) : 'N/D';
      return { ...c, origineAddress, destinazioneAddress };
    }));

    res.json(corse);
  } catch (err) {
    console.error('Errore GET /autista/today/:id', err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------
// 3️⃣ Accetta corsa / pending
// ----------------------
corseRouter.post('/:id/accetta', async (req, res) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);

    await client.query('BEGIN');

    // Accetta corsa o crea la corsa dal pending
    let corsa = await accettaCorsa(id, client);

    // Se c’è un pending collegato, aggiorna corsa_id
    if (corsa.pending_id) {
      await client.query(
        `UPDATE pending SET corsa_id = $1 WHERE id = $2`,
        [corsa.id, corsa.pending_id]
      );
    }

    await client.query('COMMIT');

    // Geocoding indirizzi lato server
    const origineAddress = corsa.origine ? await getAddress(corsa.origine) : 'N/D';
    const destinazioneAddress = corsa.destinazione ? await getAddress(corsa.destinazione) : 'N/D';
    corsa = { ...corsa, origineAddress, destinazioneAddress };

    res.json({ nuovaCorsa: corsa });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Errore POST /:id/accetta', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});