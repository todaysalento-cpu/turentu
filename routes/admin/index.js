import express from 'express';
import pixelWorkerRoutes from './pixel-worker.routes.js';
import { authMiddleware, requireRole } from '../../middleware/auth.js';

// Route esistenti
import dashboardRoutes from './dashboard.routes.js';
import pagamentiRoutes from './pagamenti.routes.js';
import gestioneRoutes from './gestione.routes.js'; // Mantenuto
import reportRoutes from './report.routes.js';
import impostazioniRoutes from './impostazioni.routes.js';
import adminNotificationsRoutes from './notifications.routes.js';

// Nuove route
import veicoliRoutes from './veicoli.routes.js';     
import corseRoutes from './corse.routes.js';         
import pendingRoutes from './pending.routes.js';     
import liveRoutes from './live.routes.js';

const router = express.Router();
router.use(authMiddleware, requireRole('Admin', 'admin'));

// --- Dashboard e Statistiche ---
router.use('/dashboard', dashboardRoutes);
router.use('/report', reportRoutes);
router.use('/live', liveRoutes);

// --- Gestione Entità ---
router.use('/gestione', gestioneRoutes); // Mantenuto
router.use('/veicoli', veicoliRoutes);
router.use('/corse', corseRoutes);
router.use('/pending', pendingRoutes);

// --- Operazioni e Servizi ---
router.use('/pagamenti', pagamentiRoutes);
router.use('/impostazioni', impostazioniRoutes);
router.use('/notifications', adminNotificationsRoutes);
router.use('/pixel-worker', pixelWorkerRoutes);

export default router;
