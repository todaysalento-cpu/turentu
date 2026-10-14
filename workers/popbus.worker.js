import cron from 'node-cron';
import { processaProposteDinamiche } from '../services/popbus/matching.worker.js';

export const startPopbusWorker = () => {
  if (process.env.POPBUS_WORKER_ENABLED === 'false') {
    console.log('⏸️ [WORKER] Scheduler PopBus disabilitato.');
    return;
  }

  cron.schedule('* * * * *', async () => {
    console.log('🔄 [WORKER] Avvio analisi proposte dinamiche...');

    try {
      await processaProposteDinamiche();
    } catch (err) {
      console.error('❌ [WORKER] Errore critico nel ciclo:', err);
    }
  });
};