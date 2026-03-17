// admin/index.js o router principale admin
import express from 'express';
import dashboardRoutes from './dashboard.routes.js';
import pagamentiRoutes from './pagamenti.routes.js';
import gestioneRoutes from './gestione.routes.js';
import reportRoutes from './report.routes.js';
import impostazioniRoutes from './impostazioni.routes.js';

// Nuove route
import liveRoutes from './live.routes.js';
import ultimeCorseRoutes from './ultime_corse.routes.js';
import ultimiPagamentiRoutes from './ultimi_pagamenti.routes.js';
import adminNotificationsRoutes from './notifications.routes.js';

const router = express.Router();

router.use('/dashboard', dashboardRoutes);
router.use('/pagamenti', pagamentiRoutes);
router.use('/gestione', gestioneRoutes);
router.use('/report', reportRoutes);
router.use('/impostazioni', impostazioniRoutes);

// Dashboard aggiuntive
router.use('/live', liveRoutes);
router.use('/ultime-corse', ultimeCorseRoutes);
router.use('/ultimi-pagamenti', ultimiPagamentiRoutes);

// Route notifiche admin
router.use('/notifications', adminNotificationsRoutes);

export default router;