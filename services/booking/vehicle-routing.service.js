
import { checkPixelStopRoadAccess } from '../pixel/pixel-stop-road-access.service.js';

/**
 * Calcola il trasferimento stradale tra due punti.
 *
 * Restituisce:
 * { metres, seconds }
 *
 * In caso di errore o percorso non verificabile,
 * impedisce di dichiarare compatibile il trasferimento.
 */
export async function calcolaTrasferimentoVeicolo(
  origine,
  destinazione,
  options = {}
) {
  const risultato = await checkPixelStopRoadAccess(
    origine,
    destinazione,
    options
  );

  if (
    risultato.stato !== 'raggiungibile' ||
    !Number.isFinite(risultato.distanza_m) ||
    !Number.isFinite(risultato.durata_s) ||
    risultato.distanza_m < 0 ||
    risultato.durata_s < 0
  ) {
    const error = new Error(
      `Trasferimento veicolo non verificabile: ${risultato.motivo}`
    );

    error.code = 'VEHICLE_TRANSFER_UNVERIFIED';
    error.status = 409;

    throw error;
  }

  return {
    metres: risultato.distanza_m,
    seconds: risultato.durata_s
  };
}
