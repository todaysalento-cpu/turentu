import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { getCorseByAutista, accettaCorsa, toggleCorsa } from '../services/corsa/corse.service.js';
import { getAddress } from '../utils/geo.util.js';
import { getIO } from '../socket.js';

export const corseRouter = express.Router();
corseRouter.use(authMiddleware);

// ----------------------
// Helper: popola indirizzi
// ----------------------
async function populateAddresses(corsa) {
  const origine_address = corsa.origine_address || (corsa.origine ? await getAddress(corsa.origine) : 'N/D');
  const destinazione_address = corsa.destinazione_address || (corsa.destinazione ? await getAddress(corsa.destinazione) : 'N/D');
  console.log(`[populateAddresses] corsa ${corsa.id}: origine=${origine_address}, destinazione=${destinazione_address}`);
  return { ...corsa, origine_address, destinazione_address };
}

// ----------------------
// 1️⃣ Tutte le corse di un autista
// ----------------------
corseRouter.get('/autista/:id', async (req, res) => {
  const autistaId = Number(req.params.id);
  console.log(`[GET] /autista/${autistaId} status=${req.query.status || ''}`);

  if (isNaN(autistaId)) return res.status(400).json({ error: 'ID autista non valido' });

  const status = req.query.status || '';
  try {
    let corse = await getCorseByAutista(autistaId, status);
    console.log(`[GET] corse trovate: ${corse.length}`);
    corse = await Promise.all(corse.map(populateAddresses));
    res.json(corse);
  } catch (err) {
    console.error('[GET /autista/:id] errore:', err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------
// 2️⃣ Corse di oggi (live page)
// ----------------------
corseRouter.get('/autista/today/:id', async (req, res) => {
  const autistaId = Number(req.params.id);
  console.log(`[GET] /autista/today/${autistaId}`);

  if (isNaN(autistaId)) return res.status(400).json({ error: 'ID autista non valido' });

  try {
    let corse = await getCorseByAutista(autistaId, 'today');
    console.log(`[GET today] corse trovate: ${corse.length}`);
    corse = await Promise.all(corse.map(populateAddresses));
    res.json(corse);
  } catch (err) {
    console.error('[GET /autista/today/:id] errore:', err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------
// 3️⃣ Accetta corsa
// ----------------------
corseRouter.post('/:id/accetta', async (req, res) => {
  const corsaId = Number(req.params.id);
  console.log(`[POST] /${corsaId}/accetta`);

  if (isNaN(corsaId)) return res.status(400).json({ error: 'ID corsa non valido' });

  try {
    let corsa = await accettaCorsa(corsaId);
    if (!corsa) return res.status(404).json({ error: 'Corsa non trovata' });

    corsa = await populateAddresses(corsa);
    corsa.stato = corsa.stato || 'prenotabile';
    console.log(`[POST] corsa accettata: ${corsa.id} veicolo=${corsa.veicolo_id}`);

    // Emit WebSocket
    try {
      const io = getIO();
      io.to(`autista_${corsa.veicolo_id}`).emit('nuova_corsa', { ...corsa, pending_id: corsa.pending_id ?? null });
      console.log(`[WS] nuova_corsa emessa a autista_${corsa.veicolo_id}`);
    } catch (err) {
      console.warn('[WS] non disponibile:', err.message);
    }

    res.json({ nuovaCorsa: corsa });
  } catch (err) {
    console.error('[POST /:id/accetta] errore:', err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------
// 4️⃣ Start corsa
// ----------------------
corseRouter.post('/:id/start', async (req, res) => {
  const corsaId = Number(req.params.id);
  console.log(`[POST] /${corsaId}/start`);

  if (isNaN(corsaId)) return res.status(400).json({ error: 'ID corsa non valido' });

  try {
    const corsa = await toggleCorsa(corsaId, 'start');
    console.log(`[POST] corsa started: ${corsa.id}`);

    try {
      const io = getIO();
      io.to(`autista_${corsa.veicolo_id}`).emit('corsaUpdate', corsa);
      console.log(`[WS] corsaUpdate emessa a autista_${corsa.veicolo_id}`);
    } catch (err) {
      console.warn('[WS] non disponibile:', err.message);
    }

    res.json({ success: true, corsa });
  } catch (err) {
    console.error('[POST /:id/start] errore:', err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------
// 5️⃣ End corsa
// ----------------------
corseRouter.post('/:id/end', async (req, res) => {
  const corsaId = Number(req.params.id);
  console.log(`[POST] /${corsaId}/end`);

  if (isNaN(corsaId)) return res.status(400).json({ error: 'ID corsa non valido' });

  try {
    const corsa = await toggleCorsa(corsaId, 'end');
    console.log(`[POST] corsa ended: ${corsa.id}`);

    try {
      const io = getIO();
      io.to(`autista_${corsa.veicolo_id}`).emit('corsaUpdate', corsa);
      console.log(`[WS] corsaUpdate emessa a autista_${corsa.veicolo_id}`);
    } catch (err) {
      console.warn('[WS] non disponibile:', err.message);
    }

    res.json({
      success: true,
      message: 'Corsa completata e pagamenti catturati',
      corsa
    });
  } catch (err) {
    console.error('[POST /:id/end] errore:', err);
    res.status(500).json({ error: err.message });
  }
});