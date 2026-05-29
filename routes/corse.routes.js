import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { getCorseByAutista, accettaCorsa, toggleCorsa } from '../services/corsa/corse.service.js';
import { getAddress } from '../utils/geo.util.js';
import { getIO } from '../socket.js';
import { CacheManager } from '../utils/cacheManager.js';
// 1. Importa i metodi di sincronizzazione della cache di ricerca
import { upsertCorsa, removeCorsa } from '../services/search/search.cache.js'; 

export const corseRouter = express.Router();
corseRouter.use(authMiddleware);

// ... (populateAddresses resta invariato)

// ======================================================
// 3️⃣ ACCETTA CORSA (AGGIORNATO)
// ======================================================
corseRouter.post('/:id/accetta', async (req, res) => {
  const corsaId = Number(req.params.id);
  try {
    let corsa = await accettaCorsa(corsaId);
    if (!corsa) return res.status(404).json({ error: 'Corsa non trovata' });

    corsa = await populateAddresses(corsa);

    CacheManager.corsa.update(corsa);
    // 2. Aggiorna motore di ricerca: la corsa è accettata
    upsertCorsa(corsa); 

    const io = getIO();
    io.to(`autista_${corsa.veicolo_id}`).emit('nuova_corsa', corsa);

    res.json({ nuovaCorsa: corsa });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ======================================================
// 5️⃣ END CORSA (AGGIORNATO)
// ======================================================
corseRouter.post('/:id/end', async (req, res) => {
  const corsaId = Number(req.params.id);
  try {
    const corsa = await toggleCorsa(corsaId, 'end');
    
    CacheManager.corsa.update(corsa);
    // 3. Rimuovi dal motore di ricerca: la corsa è conclusa
    removeCorsa(corsaId); 

    const io = getIO();
    io.to(`autista_${corsa.veicolo_id}`).emit('corsaUpdate', corsa);

    res.json({ success: true, corsa });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});