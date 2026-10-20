import cron from 'node-cron';
import { processaProposteDinamicheV2 } from '../services/popbus/v2/worker.js';

let schedulerAvviato = false;
let cicloInEsecuzione = false;

export function startPixelFirstWorker() {
  if (schedulerAvviato) {
    console.warn('[PIXEL FIRST WORKER] Scheduler gia avviato.');
    return;
  }

  if (process.env.POPBUS_PIXEL_FIRST !== '1') {
    throw new Error('[PIXEL FIRST WORKER] POPBUS_PIXEL_FIRST deve essere 1.');
  }

  if (process.env.POPBUS_PIXEL_AR_WORKER_SHADOW === '1' ||
      process.env.POPBUS_PIXEL_FEASIBILITY_READONLY === '1') {
    throw new Error('[PIXEL FIRST WORKER] Modalita shadow/read-only incompatibile.');
  }

  const mode = process.env.POPBUS_PIXEL_FIRST_MODE || 'ROLLBACK_ONLY';
  if (!['ROLLBACK_ONLY', 'LIVE'].includes(mode)) {
    throw new Error(`[PIXEL FIRST WORKER] Modalita non valida: ${mode}`);
  }

  if (mode === 'LIVE' && (
    process.env.POPBUS_PIXEL_FIRST_LIVE_APPROVED !== '1' ||
    process.env.POPBUS_MULTIMISSION_ACCEPTANCE_TEST !== 'true' ||
    process.env.POPBUS_PIXEL_COSTO_ATTESA_ORA_EURO == null
  )) {
    throw new Error('[PIXEL FIRST WORKER] LIVE non autorizzato o configurazione incompleta.');
  }

  schedulerAvviato = true;
  console.log(`[PIXEL FIRST WORKER] Scheduler avviato. Modalita=${mode}.`);

  cron.schedule('* * * * *', async () => {
    if (cicloInEsecuzione) {
      console.warn('[PIXEL FIRST WORKER] Ciclo precedente in corso; salto esecuzione.');
      return;
    }

    cicloInEsecuzione = true;
    try {
      console.log('[PIXEL FIRST WORKER] Avvio ciclo PIXEL-first.');
      const result = await processaProposteDinamicheV2();
      console.log('[PIXEL FIRST WORKER] RISULTATO:', JSON.stringify(result));
    } catch (error) {
      console.error('[PIXEL FIRST WORKER] ERRORE:', error?.stack || error);
    } finally {
      cicloInEsecuzione = false;
    }
  }, { noOverlap: true });
}
