import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { getCorseByAutista, accettaCorsa, toggleCorsa } from '../services/corsa/corse.service.js';
import { getAddress } from '../utils/geo.util.js';

export const corseRouter = express.Router();
corseRouter.use(authMiddleware);

// ----------------------
// 1️⃣ Tutte le corse dell'autista
// ----------------------
corseRouter.get('/autista/:id', async (req, res) => {
  try {
    const status = req.query.status || '';
    let corse = await getCorseByAutista(Number(req.params.id), status);

    corse = await Promise.all(
      corse.map(async c => {
        const origine_address = c.origine_address || (c.origine ? await getAddress(c.origine) : 'N/D');
        const destinazione_address = c.destinazione_address || (c.destinazione ? await getAddress(c.destinazione) : 'N/D');
        return { ...c, origine_address, destinazione_address };
      })
    );

    res.json(corse);
  } catch (err) {
    console.error('Errore GET /autista/:id', err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------
// 2️⃣ Corse della giornata (Live Page)
// ----------------------
corseRouter.get('/autista/today/:id', async (req, res) => {
  try {
    let corse = await getCorseByAutista(Number(req.params.id), 'today');

    corse = await Promise.all(
      corse.map(async c => {
        const origine_address = c.origine_address || (c.origine ? await getAddress(c.origine) : 'N/D');
        const destinazione_address = c.destinazione_address || (c.destinazione ? await getAddress(c.destinazione) : 'N/D');
        return { ...c, origine_address, destinazione_address };
      })
    );

    res.json(corse);
  } catch (err) {
    console.error('Errore GET /autista/today/:id', err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------
// 3️⃣ Accetta corsa
// ----------------------
corseRouter.post('/:id/accetta', async (req, res) => {
  try {
    let corsa = await accettaCorsa(Number(req.params.id));

    if (!corsa) {
      return res.status(404).json({ error: 'Corsa non trovata' });
    }

    const origine_address = corsa.origine_address || (corsa.origine ? await getAddress(corsa.origine) : 'N/D');
    const destinazione_address = corsa.destinazione_address || (corsa.destinazione ? await getAddress(corsa.destinazione) : 'N/D');

    corsa = {
      ...corsa,
      stato: corsa.stato || 'prenotabile',
      origine_address,
      destinazione_address
    };

    res.json({ nuovaCorsa: corsa });
  } catch (err) {
    console.error('Errore POST /:id/accetta', err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------
// 4️⃣ Inizia corsa
// ----------------------
corseRouter.post('/:id/start', async (req, res) => {
  try {
    const corsa = await toggleCorsa(Number(req.params.id), 'start');
    res.json(corsa);
  } catch (err) {
    console.error('Errore POST /:id/start', err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------
// 5️⃣ Termina corsa (con cattura pagamenti automatica)
// ----------------------
corseRouter.post('/:id/end', async (req, res) => {
  try {
    const corsa = await toggleCorsa(Number(req.params.id), 'end');
    res.json({
      message: 'Corsa completata e pagamenti catturati',
      corsa
    });
  } catch (err) {
    console.error('Errore POST /:id/end', err);
    res.status(500).json({ error: err.message });
  }
});