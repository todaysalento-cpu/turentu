import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import {
  getCorseByAutista,
  accettaCorsa,
  toggleCorsa
} from '../services/corsa/corse.service.js';
import { getAddress } from '../utils/geo.util.js';
import { getIO } from '../socket.js';

export const corseRouter = express.Router();
corseRouter.use(authMiddleware);

// ----------------------
// Helper
// ----------------------
async function populateAddresses(corsa) {
  const origine_address =
    corsa.origine_address ||
    (corsa.origine ? await getAddress(corsa.origine) : 'N/D');

  const destinazione_address =
    corsa.destinazione_address ||
    (corsa.destinazione ? await getAddress(corsa.destinazione) : 'N/D');

  return { ...corsa, origine_address, destinazione_address };
}

// ======================================================
// 1️⃣ CORSE AUTISTA (FIX: NO ID IN URL)
// ======================================================
corseRouter.get('/autista', async (req, res) => {
  try {
    const autistaId = req.user.id; // 🔥 DA JWT
    const status = req.query.status || '';

    console.log(`[GET] /autista id=${autistaId} status=${status}`);

    let corse = await getCorseByAutista(autistaId, status);

    corse = await Promise.all(corse.map(populateAddresses));

    res.json(corse);
  } catch (err) {
    console.error('[GET /autista] errore:', err);
    res.status(500).json({ error: err.message });
  }
});

// ======================================================
// 2️⃣ CORSE TODAY
// ======================================================
corseRouter.get('/autista/today', async (req, res) => {
  try {
    const autistaId = req.user.id;

    let corse = await getCorseByAutista(autistaId, 'today');

    corse = await Promise.all(corse.map(populateAddresses));

    res.json(corse);
  } catch (err) {
    console.error('[GET /today] errore:', err);
    res.status(500).json({ error: err.message });
  }
});

// ======================================================
// 3️⃣ ACCETTA CORSA
// ======================================================
corseRouter.post('/:id/accetta', async (req, res) => {
  const corsaId = Number(req.params.id);

  if (isNaN(corsaId)) {
    return res.status(400).json({ error: 'ID corsa non valido' });
  }

  try {
    let corsa = await accettaCorsa(corsaId);
    if (!corsa) {
      return res.status(404).json({ error: 'Corsa non trovata' });
    }

    corsa = await populateAddresses(corsa);

    const io = getIO();
    io.to(`autista_${corsa.veicolo_id}`).emit('nuova_corsa', corsa);

    res.json({ nuovaCorsa: corsa });
  } catch (err) {
    console.error('[accetta] errore:', err);
    res.status(500).json({ error: err.message });
  }
});

// ======================================================
// 4️⃣ START CORSA
// ======================================================
corseRouter.post('/:id/start', async (req, res) => {
  const corsaId = Number(req.params.id);

  try {
    const corsa = await toggleCorsa(corsaId, 'start');

    const io = getIO();
    io.to(`autista_${corsa.veicolo_id}`).emit('corsaUpdate', corsa);

    res.json({ success: true, corsa });
  } catch (err) {
    console.error('[start] errore:', err);
    res.status(500).json({ error: err.message });
  }
});

// ======================================================
// 5️⃣ END CORSA
// ======================================================
corseRouter.post('/:id/end', async (req, res) => {
  const corsaId = Number(req.params.id);

  try {
    const corsa = await toggleCorsa(corsaId, 'end');

    const io = getIO();
    io.to(`autista_${corsa.veicolo_id}`).emit('corsaUpdate', corsa);

    res.json({
      success: true,
      message: 'Corsa completata e pagamenti catturati',
      corsa
    });
  } catch (err) {
    console.error('[end] errore:', err);
    res.status(500).json({ error: err.message });
  }
});