import { pool } from '../db/db.js';

export async function getTariffe(veicolo_id, tipo) {
  const res = await pool.query(
    'SELECT euro_km, prezzo_passeggero FROM tariffe WHERE veicolo_id = $1 AND tipo = $2 LIMIT 1',
    [veicolo_id, tipo]
  );
  if (res.rows.length === 0) throw new Error('Tariffa non trovata');
  
  return {
    prezzoKm: Number(res.rows[0].euro_km) || 0,
    prezzoPasseggero: Number(res.rows[0].prezzo_passeggero) || 0
  };
}

/**
 * Motore di Calcolo Prezzi Turentu
 * @param {Object} corsa - Dati della corsa
 * @param {Number} postiRichiesti - Posti per questa prenotazione
 * @param {String} tipo - 'privata' | 'condivisa' | 'riempimento'
 * @param {Number} kmUtente - Km effettivi della tratta utente
 * @param {Number} kmTotali - Km totali della corsa
 * @param {Number} totPasseggeriCorrenti - Passeggeri già presenti (per condivisa)
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

    default:
      return Math.max(PREZZO_MINIMO, Math.round(prezzoKm * kmUtente * 100) / 100);
  }
}