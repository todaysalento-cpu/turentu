import { pool } from '../db/db.js';

const SOGLIA_ATTIVAZIONE_PERCENT = 0.6;

// Funzione di utilità per trovare il massimo euro_km in una lista di veicoli
async function getMaxTariffaPool(veicoli_ids) {
  if (!veicoli_ids || veicoli_ids.length === 0) return { prezzoKm: 0, prezzoPasseggero: 0 };
  
  const res = await pool.query(
    'SELECT MAX(euro_km) as max_km, MAX(prezzo_passeggero) as max_pass FROM tariffe WHERE veicolo_id = ANY($1) AND tipo = $2',
    [veicoli_ids, 'standard']
  );
  
  return {
    prezzoKm: Number(res.rows[0].max_km) || 0,
    prezzoPasseggero: Number(res.rows[0].max_pass) || 0
  };
}

export async function getTariffe(veicolo_id, tipo) {
  const tipoDaCercare = 'standard'; 
  
  const res = await pool.query(
    'SELECT euro_km, prezzo_passeggero FROM tariffe WHERE veicolo_id = $1 AND tipo = $2 LIMIT 1',
    [veicolo_id, tipoDaCercare]
  );
  
  if (res.rows.length === 0) {
    throw new Error(`Tariffa standard non trovata per il veicolo ${veicolo_id}`);
  }
  
  return {
    prezzoKm: Number(res.rows[0].euro_km) || 0,
    prezzoPasseggero: Number(res.rows[0].prezzo_passeggero) || 0
  };
}

export async function calcolaPrezzo(corsa, postiRichiesti, tipo, kmUtente, kmTotali, totPasseggeriCorrenti = 0) {
  const richiesti = Math.max(1, Number(postiRichiesti));
  let prezzoKm, prezzoPasseggero;

  // LOGICA SPECIALE PER POOL: Scegliamo il massimo tra i veicoli del pool
  if (tipo === 'pop-bus' && corsa.veicoli_pool_ids && corsa.veicoli_pool_ids.length > 0) {
    const maxTariffa = await getMaxTariffaPool(corsa.veicoli_pool_ids);
    prezzoKm = maxTariffa.prezzoKm;
    prezzoPasseggero = maxTariffa.prezzoPasseggero;
    console.log(`[Pricing Engine] Pop-Bus: Usato MAX Tariffa del pool: ${prezzoKm}`);
  } else {
    // Logica standard per singolo veicolo
    const info = await getTariffe(corsa.veicolo_id, tipo);
    prezzoKm = info.prezzoKm;
    prezzoPasseggero = info.prezzoPasseggero;
  }

  const PREZZO_MINIMO = 0.50;
  let prezzoCalcolato = 0;

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
      break;

    default:
      prezzoCalcolato = prezzoKm * kmUtente;
  }

  return Math.max(PREZZO_MINIMO, Math.round(prezzoCalcolato * 100) / 100);
}