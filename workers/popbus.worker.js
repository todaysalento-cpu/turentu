// src/workers/popbus.worker.js
import cron from 'node-cron';
import { processaProposteDinamiche } from '../services/popbus/matching.worker.js';

export const startPopbusWorker = () => {
  cron.schedule('* * * * *', async () => {
    console.log('🔄 [WORKER] Avvio analisi proposte dinamiche...');
    try {
      await processaProposteDinamiche();
    } catch (err) {
      console.error('❌ [WORKER] Errore critico nel ciclo:', err);
    }
  });
};