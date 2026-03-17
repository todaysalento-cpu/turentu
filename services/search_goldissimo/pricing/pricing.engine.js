// pricing/pricing.engine.js
import { calcolaPrezzo } from '../../../utils/pricing.util.js';

export async function calcolaPrezzoSlot({ km, tipo_corsa }, euro_km, posti_richiesti) {
  return calcolaPrezzo(
    { km, tipo_corsa, posti_prenotati: 0, primo_posto: 0 },
    euro_km ?? 1,
    1,
    posti_richiesti,
    tipo_corsa
  );
}
