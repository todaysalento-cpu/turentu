import { pool } from '../db/db.js';

const SOGLIA_ATTIVAZIONE_PERCENT = 0.6;
const DEFAULT_PREZZO_KM = 0.50;
const DEFAULT_PREZZO_PASSEGGERO = 1.00;

/**
 * Trova le tariffe massime tra un gruppo di veicoli con pulizia input
 */
async function getMaxTariffaPool(veicoli_ids) {
  // Pulizia rigorosa: converte in numero e scarta valori invalidi
  const validIds = Array.isArray(veicoli_ids) 
    ? veicoli_ids.map(Number).filter(id => !isNaN(id) && id > 0)
    : [];

  if (validIds.length === 0) {
    return { prezzoKm: DEFAULT_PREZZO_KM, prezzoPasseggero: DEFAULT_PREZZO_PASSEGGERO };
  }
  
  try {
    const res = await pool.query(
      'SELECT MAX(euro_km) as max_km, MAX(prezzo_passeggero) as max_pass FROM tariffe WHERE veicolo_id = ANY($1) AND tipo = $2',
      [validIds, 'standard']
    );
    
    return {
      prezzoKm: Number(res.rows[0]?.max_km) || DEFAULT_PREZZO_KM,
      prezzoPasseggero: Number(res.rows[0]?.max_pass) || DEFAULT_PREZZO_PASSEGGERO
    };
  } catch (err) {
    console.error("❌ Errore database in getMaxTariffaPool:", err);
    return { prezzoKm: DEFAULT_PREZZO_KM, prezzoPasseggero: DEFAULT_PREZZO_PASSEGGERO };
  }
}

/**
 * Recupera la tariffa standard per un singolo veicolo con fallback sicuri
 */
export async function getTariffe(veicolo_id, tipo) {
  const vId = Number(veicolo_id);
  if (!vId || isNaN(vId)) {
    return { prezzoKm: DEFAULT_PREZZO_KM, prezzoPasseggero: DEFAULT_PREZZO_PASSEGGERO };
  }

  try {
    const res = await pool.query(
      'SELECT euro_km, prezzo_passeggero FROM tariffe WHERE veicolo_id = $1 AND tipo = $2 LIMIT 1',
      [vId, tipo || 'standard']
    );
    
    if (res.rows.length === 0) return { prezzoKm: DEFAULT_PREZZO_KM, prezzoPasseggero: DEFAULT_PREZZO_PASSEGGERO };
    
    return {
      prezzoKm: Number(res.rows[0].euro_km) || 0,
      prezzoPasseggero: Number(res.rows[0].prezzo_passeggero) || 0
    };
  } catch (err) {
    console.error("❌ Errore database in getTariffe:", err);
    return { prezzoKm: DEFAULT_PREZZO_KM, prezzoPasseggero: DEFAULT_PREZZO_PASSEGGERO };
  }
}

/**
 * Calcola il prezzo finale con protezione totale contro errori di calcolo
 */
export async function calcolaPrezzo(corsa, postiRichiesti, tipo, kmUtente, kmTotali, totPasseggeriCorrenti = 0) {
  // Normalizzazione input numerici
  const richiesti = Math.max(1, Number(postiRichiesti) || 1);
  const kU = Number(kmUtente) || 0;
  const kT = Number(kmTotali) || 1;
  
  let prezzoKm, prezzoPasseggero;

  try {
    // 1. Logica di recupero tariffe
    if (tipo === 'pop-bus') {
      if (corsa.veicoli_pool_ids && Array.isArray(corsa.veicoli_pool_ids)) {
        const maxTariffa = await getMaxTariffaPool(corsa.veicoli_pool_ids);
        prezzoKm = maxTariffa.prezzoKm;
        prezzoPasseggero = maxTariffa.prezzoPasseggero;
      } else {
        const info = await getTariffe(corsa.veicolo_id, tipo);
        prezzoKm = info.prezzoKm;
        prezzoPasseggero = info.prezzoPasseggero;
      }
    } else {
      const info = await getTariffe(corsa.veicolo_id, tipo);
      prezzoKm = info.prezzoKm;
      prezzoPasseggero = info.prezzoPasseggero;
    }

    // 2. Calcolo logica di business
    const PREZZO_MINIMO = 0.50;
    let prezzoCalcolato = 0;

    switch (tipo) {
      case 'privata':
        prezzoCalcolato = prezzoKm * kU;
        break;

      case 'condivisa':
        const totPasseggeriFinale = Math.max(1, totPasseggeriCorrenti + richiesti);
        const passeggeriSuccessivi = Math.max(0, totPasseggeriFinale - 1);
        const costoBase = (prezzoKm * kT) + (passeggeriSuccessivi * prezzoPasseggero);
        prezzoCalcolato = (costoBase / totPasseggeriFinale) * (kU / kT);
        break;

      case 'riempimento':
        const soglia = Math.max(1, Number(corsa.posti_soglia) || 1);
        prezzoCalcolato = ((prezzoKm * kT) / soglia) * richiesti;
        break;

      case 'pop-bus':
        const postiTotali = Math.max(1, Number(corsa.posti_totali) || 1);
        prezzoCalcolato = (kU * prezzoKm) / (postiTotali * SOGLIA_ATTIVAZIONE_PERCENT);
        break;

      default:
        prezzoCalcolato = prezzoKm * kU;
    }

    // Risultato finale arrotondato e protetto
    const finale = Math.max(PREZZO_MINIMO, Math.round(prezzoCalcolato * 100) / 100);
    return isNaN(finale) ? PREZZO_MINIMO : finale;

  } catch (err) {
    console.error("💥 Errore critico nel calcolo prezzo:", err);
    return DEFAULT_PREZZO_KM; // Fallback di emergenza
  }
}