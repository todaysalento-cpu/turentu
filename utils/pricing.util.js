import { pool } from '../db/db.js';

// Costante per la soglia di attivazione (puoi spostarla in un file config)
const SOGLIA_ATTIVAZIONE_PERCENT = 0.6;

/**
 * Recupera le tariffe dal database.
 */
export async function getTariffe(veicolo_id, tipo) {
  // Per 'pop-bus', recuperiamo la tariffa 'standard' come base di calcolo
  const tipoDaCercare = (tipo === 'pop-bus') ? 'standard' : tipo;
  
  const res = await pool.query(
    'SELECT euro_km, prezzo_passeggero FROM tariffe WHERE veicolo_id = $1 AND tipo = $2 LIMIT 1',
    [veicolo_id, tipoDaCercare]
  );
  
  if (res.rows.length === 0) throw new Error('Tariffa non trovata');
  
  return {
    prezzoKm: Number(res.rows[0].euro_km) || 0,
    prezzoPasseggero: Number(res.rows[0].prezzo_passeggero) || 0
  };
}

/**
 * Motore di Calcolo Prezzi Turentu
 */
export async function calcolaPrezzo(corsa, postiRichiesti, tipo, kmUtente, kmTotali, totPasseggeriCorrenti = 0) {
  const richiesti = Math.max(1, Number(postiRichiesti));
  const { prezzoKm, prezzoPasseggero } = await getTariffe(corsa.veicolo_id, tipo);

  // Lavoriamo in centesimi per evitare errori di precisione float
  const PREZZO_MINIMO = 50; // 0.50€

  switch (tipo) {
    case 'privata':
      // Formula: euro_km * km tratta
      return Math.max(PREZZO_MINIMO, Math.round(prezzoKm * kmUtente * 100) / 100);

    case 'condivisa':
      // Formula: ((euro_km * km_totali) + (Passeggeri_successivi * €_passeggero)) / Totale_passeggeri
      const totPasseggeriFinale = Math.max(1, totPasseggeriCorrenti + richiesti);
      const passeggeriSuccessivi = Math.max(0, totPasseggeriFinale - 1);
      
      const costoBase = (prezzoKm * kmTotali) + (passeggeriSuccessivi * prezzoPasseggero);
      const prezzoFinale = (costoBase / totPasseggeriFinale) * (kmUtente / kmTotali);
      
      return Math.max(PREZZO_MINIMO, Math.round(prezzoFinale * 100) / 100);

    case 'riempimento':
      // Formula: (euro_km * km_totali) / n_passeggeri_soglia
      const soglia = Math.max(1, Number(corsa.posti_soglia || 1));
      const prezzoUnitarioSoglia = (prezzoKm * kmTotali) / soglia;
      
      return Math.max(PREZZO_MINIMO, Math.round(prezzoUnitarioSoglia * richiesti * 100) / 100);

    case 'pop-bus':
      // FORMULA: (kmUtente * euro_km) / posti_totali * soglia_attivazione
      const postiTotali = Number(corsa.posti_totali || 1);
      const prezzoPool = ((kmUtente * prezzoKm) / postiTotali) * SOGLIA_ATTIVAZIONE_PERCENT;
      
      return Math.max(PREZZO_MINIMO, Math.round(prezzoPool * 100) / 100);

    default:
      return Math.max(PREZZO_MINIMO, Math.round(prezzoKm * kmUtente * 100) / 100);
  }
}