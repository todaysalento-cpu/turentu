import express from 'express';

// Route esistenti
import dashboardRoutes from './dashboard.routes.js';
import pagamentiRoutes from './pagamenti.routes.js';
import reportRoutes from './report.routes.js';
import impostazioniRoutes from './impostazioni.routes.js';
import adminNotificationsRoutes from './notifications.routes.js';

// Nuove route specifiche per la gestione amministrativa
import utentiRoutes from './utenti.routes.js';       // ex gestione.routes.js
import veicoliRoutes from './veicoli.routes.js';     // Nuova
import corseRoutes from './corse.routes.js';         // Nuova
import pendingRoutes from './pending.routes.js';     // Nuova
import liveRoutes from './live.routes.js';

const router = express.Router();

// --- Dashboard e Statistiche ---
router.use('/dashboard', dashboardRoutes);
router.use('/report', reportRoutes);
router.use('/live', liveRoutes);

// --- Gestione Entità (Il cuore del tuo Admin Management) ---
router.use('/utenti', utentiRoutes);
router.use('/veicoli', veicoliRoutes);
router.use('/corse', corseRoutes);
router.use('/pending', pendingRoutes);

// --- Operazioni e Servizi ---
router.use('/pagamenti', pagamentiRoutes);
router.use('/impostazioni', impostazioniRoutes);
router.use('/notifications', adminNotificationsRoutes);

export default router;