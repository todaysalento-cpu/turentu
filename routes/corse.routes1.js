import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { getCorseByAutista, accettaCorsa } from '../services/corsa/corse.service.js';

export const corseRouter = express.Router();

// ----------------------
// 1️⃣ Tutte le corse non completate dell'autista
// ----------------------
corseRouter.get('/autista/:id', authMiddleware, async (req, res) => {
  try {
    const status = req.query.status || ''; // es. ?status=non_completate
    let corse;

    if (status === 'non_completate') {
      corse = await getCorseByAutista(Number(req.params.id), 'non_completate');
    } else {
      // default: ritorna tutte le corse (per sicurezza)
      corse = await getCorseByAutista(Number(req.params.id), '');
    }

    res.json(corse);
  } catch (err) {
    console.error('Errore GET /autista/:id', err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------
// 2️⃣ Corse della giornata (pagina Live)
// ----------------------
corseRouter.get('/autista/today/:id', authMiddleware, async (req, res) => {
  try {
    const corse = await getCorseByAutista(Number(req.params.id), 'today');
    res.json(corse);
  } catch (err) {
    console.error('Errore GET /autista/today/:id', err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------
// 3️⃣ Accetta corsa
// ----------------------
corseRouter.post('/:id/accetta', authMiddleware, async (req, res) => {
  try {
    const corsa = await accettaCorsa(Number(req.params.id));
    res.json(corsa);
  } catch (err) {
    console.error('Errore POST /:id/accetta', err);
    res.status(500).json({ error: err.message });
  }
});
