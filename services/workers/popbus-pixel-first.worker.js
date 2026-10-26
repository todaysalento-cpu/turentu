// TURENTU - scheduler unico PIXEL-first. Integrazione progressiva, opt-in.
import cron from 'node-cron';
import { processaProposteDinamicheV2 } from '../services/popbus/v2/worker.js';
import { processaPixelOperativo } from '../services/pixel/pixel-operational.service.js';

let schedulerAvviato = false;
let cicloInEsecuzione = false;

export async function eseguiCicloPixelFirstControllato() {
  const mode = process.env.POPBUS_PIXEL_FIRST_MODE || 'ROLLBACK_ONLY';
  if (!['ROLLBACK_ONLY', 'LIVE'].includes(mode)) throw new Error('Modalita POPBUS non valida');
  const pipeline = process.env.PIXEL_FIRST_PIPELINE_ENABLED === '1';
  let pixel = null;
  if (pipeline) {
    if (mode === 'LIVE') {
      if (process.env.PIXEL_FIRST_PIPELINE_LIVE_APPROVED !== '1' ||
          process.env.PIXEL_OPERATIONAL_LIVE_APPROVED !== '1' ||
          process.env.POPBUS_PIXEL_FIRST_LIVE_APPROVED !== '1' ||
          process.env.POPBUS_MULTIMISSION_ACCEPTANCE_TEST !== 'true') {
        throw new Error('[PIXEL FIRST WORKER] Pipeline LIVE non autorizzata');
      }
    }
    pixel = await processaPixelOperativo({mode});
    if (mode === 'LIVE' && pixel.committed !== true) {
      throw new Error('[PIXEL FIRST WORKER] PIXEL non ha confermato la pubblicazione');
    }
  }
  // In rollback POPBUS vede SOLO le opportunita gia persistite: NON e un E2E
  // delle nuove opportunita PIXEL. Nessun commit di prova e consentito.
  const popbus = await processaProposteDinamicheV2();
  return {pipelineAbilitata:pipeline, mode, pixel, popbus,
    collaudoIntegratoNuoveOpportunita: false};
}

export function startPixelFirstWorker() {
  if (schedulerAvviato) {
    console.warn('[PIXEL FIRST WORKER] Scheduler gia avviato.');
    return;
  }
  if (process.env.POPBUS_PIXEL_FIRST !== '1')
    throw new Error('[PIXEL FIRST WORKER] POPBUS_PIXEL_FIRST deve essere 1.');
  if (process.env.POPBUS_PIXEL_AR_WORKER_SHADOW === '1' ||
      process.env.POPBUS_PIXEL_FEASIBILITY_READONLY === '1')
    throw new Error('[PIXEL FIRST WORKER] Modalita shadow/read-only incompatibile.');
  const mode = process.env.POPBUS_PIXEL_FIRST_MODE || 'ROLLBACK_ONLY';
  if (!['ROLLBACK_ONLY','LIVE'].includes(mode))
    throw new Error(`[PIXEL FIRST WORKER] Modalita non valida: ${mode}`);
  if (mode === 'LIVE' && (
    process.env.POPBUS_PIXEL_FIRST_LIVE_APPROVED !== '1' ||
    process.env.POPBUS_MULTIMISSION_ACCEPTANCE_TEST !== 'true' ||
    process.env.POPBUS_PIXEL_COSTO_ATTESA_ORA_EURO == null
  )) throw new Error('[PIXEL FIRST WORKER] LIVE non autorizzato o configurazione incompleta.');
  if (mode === 'LIVE' && process.env.PIXEL_FIRST_PIPELINE_ENABLED === '1' &&
      (process.env.PIXEL_FIRST_PIPELINE_LIVE_APPROVED !== '1' ||
       process.env.PIXEL_OPERATIONAL_LIVE_APPROVED !== '1'))
    throw new Error('[PIXEL FIRST WORKER] Pipeline PIXEL LIVE non autorizzata.');

  schedulerAvviato = true;
  console.log(`[PIXEL FIRST WORKER] Scheduler avviato. Modalita=${mode}. Pipeline=${process.env.PIXEL_FIRST_PIPELINE_ENABLED === '1'}.`);
  cron.schedule('* * * * *', async () => {
    if (cicloInEsecuzione) {
      console.warn('[PIXEL FIRST WORKER] Ciclo precedente in corso; salto esecuzione.');
      return;
    }
    cicloInEsecuzione = true;
    try {
      const result = await eseguiCicloPixelFirstControllato();
      console.log('[PIXEL FIRST WORKER] RISULTATO:', JSON.stringify(result));
    } catch (error) {
      console.error('[PIXEL FIRST WORKER] ERRORE:', error?.stack || error);
    } finally {
      cicloInEsecuzione = false;
    }
  }, { noOverlap: true });
}
