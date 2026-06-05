import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { getCorseByAutista, accettaCorsa, toggleCorsa } from '../services/corsa/corse.service.js';
import { getIO } from '../socket.js';
import { CacheManager } from '../utils/cacheManager.js';
import { upsertCorsa, removeCorsa } from '../services/search/search.cache.js'; 

export const corseRouter = express.Router();

// Middleware di autenticazione per tutte le rotte sotto corseRouter
corseRouter.use(authMiddleware);

// --- HELPER TEMPORANEO (se non lo hai già importato da un file esterno) ---
const populateAddresses = async (corsa) => {
    // Implementa la logica di geocoding o ritorno dell'oggetto originale
    return corsa; 
};

// ======================================================
// 1️⃣ GET CORSE AUTISTA TODAY (LA ROTTA MANCANTE)
// ======================================================
corseRouter.get('/autista/today', async (req, res) => {
    try {
        // req.user.id viene iniettato dal tuo authMiddleware
        const driverId = req.user.id; 
        const corse = await getCorseByAutista(driverId, 'today');
        
        // Risposta al frontend con la lista delle corse
        res.json(corse);
    } catch (err) {
        console.error("❌ Errore in GET /api/corse/autista/today:", err);
        res.status(500).json({ error: err.message });
    }
});

// ======================================================
// 3️⃣ ACCETTA CORSA
// ======================================================
corseRouter.post('/:id/accetta', async (req, res) => {
  const corsaId = Number(req.params.id);
  try {
    let corsa = await accettaCorsa(corsaId);
    if (!corsa) return res.status(404).json({ error: 'Corsa non trovata' });

    corsa = await populateAddresses(corsa);

    CacheManager.corsa.update(corsa);
    // Aggiorna motore di ricerca: la corsa è accettata
    upsertCorsa(corsa); 

    const io = getIO();
    io.to(`autista_${corsa.veicolo_id}`).emit('nuova_corsa', corsa);

    res.json({ nuovaCorsa: corsa });
  } catch (err) {
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
    
    CacheManager.corsa.update(corsa);
    // Rimuovi dal motore di ricerca: la corsa è conclusa
    removeCorsa(corsaId); 

    const io = getIO();
    io.to(`autista_${corsa.veicolo_id}`).emit('corsaUpdate', corsa);

    res.json({ success: true, corsa });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});