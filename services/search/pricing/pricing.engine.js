// pricing/pricing.engine.js
import { calcolaPrezzo } from '../../../utils/pricing.util.js';

/**
 * Calcola il prezzo di uno slot libero
 * @param {Object} slot - { km, tipo_corsa, veicolo_id }
 * @param {number} posti_richiesti - Numero di posti richiesti
 */
export async function calcolaPrezzoSlot(slot, posti_richiesti) {
  return calcolaPrezzo(
    {
      km: slot.km,
      tipo_corsa: slot.tipo_corsa,
      posti_prenotati: 0,
      primo_posto: 0,
      veicolo_id: slot.veicolo_id
    },
    posti_richiesti,
    'libero'
  );
}
