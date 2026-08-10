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
// 1️⃣ GET CORSE AUTISTA TODAY
// ======================================================
corseRouter.get('/autista/today', async (req, res) => {
    try {
        const driverId = req.user.id; 
        console.log(`🔍 [API CORSE] Richiesta /autista/today per driverId:`, driverId);
        
        const corse = await getCorseByAutista(driverId, 'today');
        console.log(`📦 [API CORSE] Risultato today:`, corse);
        
        res.json(corse);
    } catch (err) {
        console.error("❌ Errore in GET /api/corse/autista/today:", err);
        res.status(500).json({ error: err.message });
    }
});

// ======================================================
// 2️⃣ GET TUTTE LE CORSE AUTISTA
// ======================================================
corseRouter.get('/autista/all', async (req, res) => {
    try {
        const driverId = req.user.id;
        const status = req.query.status;
        const filter = (status && status !== 'tutte') ? status : 'tutte';
        
        console.log(`🔍 [API CORSE] Richiesta /autista/all per driverId: ${driverId} con filtro stato: ${filter}`);
        
        const corse = await getCorseByAutista(driverId, filter);
        console.log(`📦 [API CORSE] Risultato all:`, corse);
        
        res.json(corse);
    } catch (err) {
        console.error("❌ Errore in GET /api/corse/autista/all:", err);
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
    upsertCorsa(corsa); 

    const io = getIO();
    io.to(`autista_${corsa.veicolo_id}`).emit('nuova_corsa', corsa);

    res.json({ nuovaCorsa: corsa });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ======================================================
// 4️⃣ START CORSA (AGGIUNTO)
// ======================================================
corseRouter.post('/:id/start', async (req, res) => {
  const corsaId = Number(req.params.id);
  try {
    const corsa = await toggleCorsa(corsaId, 'start');
    if (!corsa) return res.status(404).json({ error: 'Corsa non trovata' });
    
    CacheManager.corsa.update(corsa);
    upsertCorsa(corsa); 

    const io = getIO();
    io.to(`autista_${corsa.veicolo_id}`).emit('corsaUpdate', corsa);

    res.json({ success: true, corsa });
  } catch (err) {
    console.error("❌ Errore in POST /api/corse/:id/start:", err);
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
    if (!corsa) return res.status(404).json({ error: 'Corsa non trovata' });
    
    CacheManager.corsa.update(corsa);
    removeCorsa(corsaId); 

    const io = getIO();
    io.to(`autista_${corsa.veicolo_id}`).emit('corsaUpdate', corsa);

    res.json({ success: true, corsa });
  } catch (err) {
    console.error("❌ Errore in POST /api/corse/:id/end:", err);
    res.status(500).json({ error: err.message });
  }
});