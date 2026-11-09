// TURENTU - scheduler unico PIXEL-first. Integrazione progressiva, opt-in.
import cron from 'node-cron';
import { processaProposteDinamicheV2 } from '../services/popbus/v2/worker.js';
import { processaPixelOperativo } from '../services/pixel/pixel-operational.service.js';

import { createPixelFirstScheduler } from './pixel-first-scheduler.js';
import { readPixelLiveRoutingLimit, withPixelRoutingBudget } from '../utils/pixel-routing-budget.js';

const scheduler = createPixelFirstScheduler({
  schedule: (...args) => cron.schedule(...args),
  run: async () => {
    const result = await eseguiCicloPixelFirstControllato();
    // Do not log candidate passengers, coordinates or complete mission payloads.
    console.log('[PIXEL FIRST WORKER] RISULTATO:', JSON.stringify({
      mode: result.mode, osservazioneFisica: result.osservazioneFisica,
      routingRequests: result.routingRequests, routingLimit: result.routingLimit,
      persistita: result.popbus?.persistita === true,
      offerte: result.popbus?.offerte ?? 0
    }));
  }
});
export const getPixelFirstWorkerStatus = () => scheduler.status();
export const stopPixelFirstWorker = options => scheduler.stop(options);

export async function eseguiCicloPixelFirstControllato() {
  const mode = process.env.POPBUS_PIXEL_FIRST_MODE || 'ROLLBACK_ONLY';
  validaOsservazioneFisica(mode);
  if (!['ROLLBACK_ONLY', 'LIVE'].includes(mode)) throw new Error('Modalita POPBUS non valida');
  return mode === 'LIVE'
    ? withPixelRoutingBudget(readPixelLiveRoutingLimit(), () => eseguiPipeline(mode))
    : eseguiPipeline(mode);
}

async function eseguiPipeline(mode) {
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
    osservazioneFisica: process.env.POPBUS_PIXEL_PHYSICAL_OBSERVATION === '1',
    collaudoIntegratoNuoveOpportunita: false};
}

export function startPixelFirstWorker() {
  if (scheduler.status().scheduled) {
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

  validaOsservazioneFisica(mode);
  if (mode === 'LIVE') readPixelLiveRoutingLimit();
  const status = scheduler.start();
  console.log(`[PIXEL FIRST WORKER] Scheduler avviato. Modalita=${mode}.`);
  return status;
}

function validaOsservazioneFisica(mode) {
  const flag=process.env.POPBUS_PIXEL_PHYSICAL_OBSERVATION ?? '0';
  if(!['0','1'].includes(flag)) throw new Error('PIXEL_PHYSICAL_OBSERVATION_INVALID');
  if(flag==='1' && mode!=='ROLLBACK_ONLY') throw new Error('PIXEL_PHYSICAL_OBSERVATION_REQUIRES_ROLLBACK');
}
