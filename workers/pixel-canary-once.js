import { pool } from '../db/db.js';
import { processaPixelFirstMultimissione } from '../services/popbus/v2/pixel-first-multimission-service.js';
import { validateCanaryScope } from '../services/popbus/v2/popbus-canary-scope.js';
import { getPixelFirstWorkerStatus } from './popbus-pixel-first.worker.js';
import { getPixelObservationOnceStatus } from './pixel-observation-once.js';

const conflict = code => Object.assign(new Error(code), { code, status: 409 });

export function createPixelCanaryOnce({ execute, workerStatus, observationStatus, env = process.env }) {
  let state = { state: 'IDLE', scope: 'PROCESS_LOCAL' };
  let completion;
  const status = () => structuredClone(state);

  function start() {
    if (env.POPBUS_PIXEL_CANARY_APPROVED !== '1' || env.POPBUS_PIXEL_FIRST_MODE !== 'ROLLBACK_ONLY' ||
        env.POPBUS_PIXEL_FIRST_ENABLED !== 'false' || env.POPBUS_WORKER_ENABLED !== 'false' ||
        env.PIXEL_FIRST_PIPELINE_ENABLED !== '0' || env.POPBUS_PIXEL_OBSERVATION_ONCE_ALLOWED !== '0' ||
        ['POPBUS_PIXEL_FIRST_LIVE_APPROVED', 'PIXEL_FIRST_PIPELINE_LIVE_APPROVED',
          'PIXEL_OPERATIONAL_LIVE_APPROVED'].some(key => env[key] !== '0')) {
      throw conflict('PIXEL_CANARY_NOT_AUTHORIZED');
    }
    if (state.state !== 'IDLE') throw conflict('PIXEL_CANARY_ALREADY_USED');
    const worker = workerStatus();
    if (worker.scheduled || worker.running || worker.stopping || observationStatus().state === 'RUNNING') {
      throw conflict('PIXEL_CANARY_WORKER_ACTIVE');
    }
    const values = ['OPPORTUNITY_ID', 'VEHICLE_ID', 'OPERATOR_ID']
      .map(key => env[`POPBUS_PIXEL_CANARY_${key}`] ?? '');
    if (!values.every(value => /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)))) {
      throw conflict('PIXEL_CANARY_SCOPE_INVALID');
    }
    const [opportunityId, vehicleId, operatorId] = values.map(Number);
    const canaryScope = validateCanaryScope({ opportunityId, vehicleId, operatorId });
    state = { ...state, state: 'RUNNING', opportunityId, vehicleId, operatorId };
    completion = Promise.resolve().then(() => execute({ mode: 'LIVE', canaryScope })).then(result => {
      if (result?.persistita === false && result.offerte === 0) {
        state = { ...state, state: 'NO_ACTIVATION', persisted: false };
      } else if (result?.persistita === true && result.offerte === 1 &&
          Number.isSafeInteger(result.attivazioneId) && Number.isSafeInteger(result.offertaId)) {
        state = { ...state, state: 'COMPLETED', persisted: true,
          activationId: result.attivazioneId, offerId: result.offertaId };
      } else {
        state = { ...state, state: 'FAILED', reason: 'PIXEL_CANARY_RESULT_UNVERIFIED' };
      }
    }).catch(() => {
      // A failed response cannot prove that a commit did not reach PostgreSQL.
      state = { ...state, state: 'FAILED', reason: 'PIXEL_CANARY_RESULT_UNVERIFIED' };
    });
    return status();
  }

  return { start, status, settled: () => completion };
}

const canary = createPixelCanaryOnce({
  execute: args => processaPixelFirstMultimissione({ pool, ...args }),
  workerStatus: getPixelFirstWorkerStatus,
  observationStatus: getPixelObservationOnceStatus
});
export const startPixelCanaryOnce = canary.start;
export const getPixelCanaryStatus = canary.status;
