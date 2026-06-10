import { pool } from '../db/db.js';

const SOGLIA_ATTIVAZIONE_PERCENT = 0.6;
const TARIFF_DEFAULT = { prezzoKm: 0.50, prezzoPasseggero: 1.00 };
const PREZZO_MAX_CAP = 5.00; // Cap di sicurezza per evitare prezzi folli

/**
 * Recupera la tariffa migliore (priorità: 'standard', poi qualsiasi altra disponibile)
 */
export async function getTariffe(veicolo_id) {
  if (!veicolo_id) return TARIFF_DEFAULT;

  const res = await pool.query(
    `SELECT euro_km, prezzo_passeggero 
     FROM tariffe 
     WHERE veicolo_id = $1 
     ORDER BY CASE WHEN tipo = 'standard' THEN 1 ELSE 2 END ASC 
     LIMIT 1`,
    [veicolo_id]
  );
  
  return res.rows.length > 0 
    ? { 
        prezzoKm: Number(res.rows[0].euro_km), 
        prezzoPasseggero: Number(res.rows[0].prezzo_passeggero) 
      }
    : TARIFF_DEFAULT;
}

/**
 * Trova la media delle tariffe tra un gruppo di veicoli per evitare picchi assurdi
 */
async function getAverageTariffaPool(veicoli_ids) {
  if (!veicoli_ids || !Array.isArray(veicoli_ids) || veicoli_ids.length === 0) {
    return TARIFF_DEFAULT;
  }
  
  const res = await pool.query(
    `SELECT AVG(euro_km) as avg_km, AVG(prezzo_passeggero) as avg_pass 
     FROM tariffe 
     WHERE veicolo_id = ANY($1)`,
    [veicoli_ids]
  );
  
  const avgKm = Number(res.rows[0]?.avg_km);
  return {
    prezzoKm: (avgKm > 0 && avgKm <= PREZZO_MAX_CAP) ? avgKm : 1.00,
    prezzoPasseggero: Number(res.rows[0]?.avg_pass) || 1.00
  };
}

/**
 * Calcola il prezzo finale
 */
export async function calcolaPrezzo(corsa, postiRichiesti, tipo, kmUtente, kmTotali, totPasseggeriCorrenti = 0) {
  // Pulizia tipo per evitare fallback errati
  const tipoValido = ['privata', 'condivisa', 'popbus', 'pop-bus'].includes(tipo) 
                     ? tipo 
                     : 'standard';

  console.log(`\n💰 [PRICING] Calcolo | Tipo: ${tipoValido} | KM Utente: ${kmUtente.toFixed(2)} | Posti: ${postiRichiesti}`);
  
  const richiesti = Math.max(1, Number(postiRichiesti));
  let prezzoKm, prezzoPasseggero;

  // 1. Recupero tariffe
  if ((tipoValido === 'popbus' || tipoValido === 'pop-bus') && corsa.veicoli_pool_ids?.length > 0) {
    const avgTariffa = await getAverageTariffaPool(corsa.veicoli_pool_ids);
    prezzoKm = avgTariffa.prezzoKm;
    prezzoPasseggero = avgTariffa.prezzoPasseggero;
  } else {
    const info = corsa.veicolo_id ? await getTariffe(corsa.veicolo_id) : TARIFF_DEFAULT;
    prezzoKm = info.prezzoKm;
    prezzoPasseggero = info.prezzoPasseggero;
  }

  const PREZZO_MINIMO = 0.50;
  let prezzoCalcolato = 0;

  // 2. Calcolo base tipo
  switch (tipoValido) {
    case 'privata':
    case 'standard':
      prezzoCalcolato = prezzoKm * kmUtente;
      break;

    case 'condivisa':
      const totPasseggeriFinale = Math.max(1, totPasseggeriCorrenti + richiesti);
      const passeggeriSuccessivi = Math.max(0, totPasseggeriFinale - 1);
      const costoBase = (prezzoKm * kmTotali) + (passeggeriSuccessivi * prezzoPasseggero);
      prezzoCalcolato = (costoBase / totPasseggeriFinale) * (kmUtente / kmTotali);
      break;

    case 'popbus':
    case 'pop-bus':
      const postiTotali = Number(corsa.posti_totali || 8);
      prezzoCalcolato = (kmUtente * prezzoKm) / (postiTotali * SOGLIA_ATTIVAZIONE_PERCENT);
      break;

    default:
      prezzoCalcolato = prezzoKm * kmUtente;
  }

  const finale = Math.max(PREZZO_MINIMO, Math.round(prezzoCalcolato * 100) / 100);
  console.log(`✅ [PRICING] Risultato Finale: ${finale}€`);
  return finale;
}