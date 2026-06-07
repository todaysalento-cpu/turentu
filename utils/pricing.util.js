import { pool } from '../db/db.js';

const SOGLIA_ATTIVAZIONE_PERCENT = 0.6;

/**
 * Trova le tariffe massime tra un gruppo di veicoli
 */
async function getMaxTariffaPool(veicoli_ids) {
  if (!veicoli_ids || !Array.isArray(veicoli_ids) || veicoli_ids.length === 0) {
    console.log("⚠️ [PRICING] Pool vuoto, ritorno default");
    return { prezzoKm: 0.50, prezzoPasseggero: 1.00 };
  }
  
  const res = await pool.query(
    'SELECT MAX(euro_km) as max_km, MAX(prezzo_passeggero) as max_pass FROM tariffe WHERE veicolo_id = ANY($1) AND tipo = $2',
    [veicoli_ids, 'standard']
  );
  
  const tariffa = {
    prezzoKm: Number(res.rows[0].max_km) || 0.50,
    prezzoPasseggero: Number(res.rows[0].max_pass) || 1.00
  };

  console.log(`🔍 [PRICING] Pool Tariffe trovate: KM=${tariffa.prezzoKm}, Pass=${tariffa.prezzoPasseggero} per ${veicoli_ids.length} veicoli`);
  return tariffa;
}

/**
 * Recupera la tariffa specifica o fallback su standard per veicolo
 */
export async function getTariffe(veicolo_id, tipo) {
  if (!veicolo_id) {
    console.warn("⚠️ [PRICING] Veicolo ID nullo, ritorno default");
    return { prezzoKm: 0.50, prezzoPasseggero: 1.00 };
  }

  // 1. Tenta recupero tariffa specifica per tipo
  let res = await pool.query(
    'SELECT euro_km, prezzo_passeggero FROM tariffe WHERE veicolo_id = $1 AND tipo = $2 LIMIT 1',
    [veicolo_id, tipo]
  );
  
  // 2. Fallback: Se non trova il tipo specifico, cerca lo 'standard'
  if (res.rows.length === 0 && tipo !== 'standard') {
    console.warn(`⚠️ [PRICING] Tariffa '${tipo}' non trovata per veicolo ${veicolo_id}. Fallback su 'standard'.`);
    res = await pool.query(
      'SELECT euro_km, prezzo_passeggero FROM tariffe WHERE veicolo_id = $1 AND tipo = $2 LIMIT 1',
      [veicolo_id, 'standard']
    );
  }

  // 3. Se ancora non trova nulla, logga ma non crashare
  if (res.rows.length === 0) {
    console.error(`❌ [PRICING] Nessuna tariffa disponibile per veicolo ${veicolo_id}. Uso default.`);
    return { prezzoKm: 0.50, prezzoPasseggero: 1.00 };
  }
  
  const t = {
    prezzoKm: Number(res.rows[0].euro_km) || 0.50,
    prezzoPasseggero: Number(res.rows[0].prezzo_passeggero) || 1.00
  };
  
  console.log(`🔍 [PRICING] Tariffa singola veicolo ${veicolo_id}: KM=${t.prezzoKm}`);
  return t;
}

/**
 * Calcola il prezzo finale
 */
export async function calcolaPrezzo(corsa, postiRichiesti, tipo, kmUtente, kmTotali, totPasseggeriCorrenti = 0) {
  console.log(`\n💰 [PRICING] Calcolo | Tipo: ${tipo} | KM Utente: ${kmUtente.toFixed(2)} | Posti: ${postiRichiesti}`);
  
  const richiesti = Math.max(1, Number(postiRichiesti));
  let prezzoKm, prezzoPasseggero;

  // 1. Recupero tariffe
  if (tipo === 'pop-bus') {
    if (corsa.veicoli_pool_ids && corsa.veicoli_pool_ids.length > 0) {
      const maxTariffa = await getMaxTariffaPool(corsa.veicoli_pool_ids);
      prezzoKm = maxTariffa.prezzoKm;
      prezzoPasseggero = maxTariffa.prezzoPasseggero;
    } else {
      const info = await getTariffe(corsa.veicolo_id, 'standard');
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

  // 2. Calcolo base tipo
  switch (tipo) {
    case 'privata':
      prezzoCalcolato = prezzoKm * kmUtente;
      break;

    case 'condivisa':
      const totPasseggeriFinale = Math.max(1, totPasseggeriCorrenti + richiesti);
      const passeggeriSuccessivi = Math.max(0, totPasseggeriFinale - 1);
      const costoBase = (prezzoKm * kmTotali) + (passeggeriSuccessivi * prezzoPasseggero);
      prezzoCalcolato = (costoBase / totPasseggeriFinale) * (kmUtente / kmTotali);
      break;

    case 'riempimento':
      const soglia = Math.max(1, Number(corsa.posti_soglia || 1));
      const prezzoUnitarioSoglia = (prezzoKm * kmTotali) / soglia;
      prezzoCalcolato = prezzoUnitarioSoglia * richiesti;
      break;

    case 'pop-bus':
      const postiTotali = Number(corsa.posti_totali || 1);
      prezzoCalcolato = (kmUtente * prezzoKm) / (postiTotali * SOGLIA_ATTIVAZIONE_PERCENT);
      console.log(`🔍 [PRICING] Pop-Bus | PostiTotali: ${postiTotali} | Prezzo Base: ${prezzoCalcolato.toFixed(2)}`);
      break;

    default:
      prezzoCalcolato = prezzoKm * kmUtente;
  }

  const finale = Math.max(PREZZO_MINIMO, Math.round(prezzoCalcolato * 100) / 100);
  console.log(`✅ [PRICING] Risultato Finale: ${finale}€`);
  return finale;
}