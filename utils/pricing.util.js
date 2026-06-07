import { pool } from '../db/db.js';

const SOGLIA_ATTIVAZIONE_PERCENT = 0.6;

/**
 * Trova le tariffe massime tra un gruppo di veicoli
 */
async function getMaxTariffaPool(veicoli_ids) {
  // 1. Filtraggio rigoroso: prendi solo i numeri validi, scarta NaN, null o undefined
  const validIds = Array.isArray(veicoli_ids) 
    ? veicoli_ids.map(Number).filter(id => !isNaN(id) && id > 0)
    : [];

  // 2. Se dopo il filtro l'array è vuoto, restituisci default
  if (validIds.length === 0) {
    return { prezzoKm: 0.50, prezzoPasseggero: 1.00 };
  }
  
  const res = await pool.query(
    'SELECT MAX(euro_km) as max_km, MAX(prezzo_passeggero) as max_pass FROM tariffe WHERE veicolo_id = ANY($1) AND tipo = $2',
    [validIds, 'standard']
  );
  
  return {
    prezzoKm: Number(res.rows[0]?.max_km) || 0.50,
    prezzoPasseggero: Number(res.rows[0]?.max_pass) || 1.00
  };
}

/**
 * Recupera la tariffa standard per un singolo veicolo
 */
export async function getTariffe(veicolo_id, tipo) {
  // Conversione sicura
  const vId = Number(veicolo_id);
  if (!vId || isNaN(vId)) {
    return { prezzoKm: 0.50, prezzoPasseggero: 1.00 };
  }

  const res = await pool.query(
    'SELECT euro_km, prezzo_passeggero FROM tariffe WHERE veicolo_id = $1 AND tipo = $2 LIMIT 1',
    [vId, tipo || 'standard']
  );
  
  return {
    prezzoKm: Number(res.rows[0]?.euro_km) || 0,
    prezzoPasseggero: Number(res.rows[0]?.prezzo_passeggero) || 0
  };
}

/**
 * Calcola il prezzo finale con protezione totale contro NaN
 */
export async function calcolaPrezzo(corsa, postiRichiesti, tipo, kmUtente, kmTotali, totPasseggeriCorrenti = 0) {
  // Convergenza sicura dei parametri numerici in ingresso
  const richiesti = Math.max(1, Number(postiRichiesti) || 1);
  const kU = Number(kmUtente) || 0;
  const kT = Number(kmTotali) || 1;
  
  let prezzoKm, prezzoPasseggero;

  try {
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

    return Math.max(PREZZO_MINIMO, Math.round(prezzoCalcolato * 100) / 100);
  } catch (error) {
    console.error("💥 Errore critico nel calcolo prezzo:", error);
    return Math.round((kU * 0.50) * 100) / 100; // Fallback di emergenza
  }
}