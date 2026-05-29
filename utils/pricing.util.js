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
 * Calcolo Prezzo Dinamico
 * @param {Object} corsa - Dati corsa
 * @param {number} postiRichiesti - Posti chiesti dall'utente
 * @param {string} statoSlot - Stato (prenotabile, ecc)
 * @param {number} kmPrenotati - Km richiesti in questa specifica prenotazione
 * @param {number} kmTotaliCorsa - Km totali della corsa dell'autista
 */
export async function calcolaPrezzo(corsa, postiRichiesti, statoSlot, kmPrenotati = 0, kmTotaliCorsa = 0) {
  const richiesti = Number(postiRichiesti) || 1;
  const tipoTariffa = 'standard';

  let prezzoKm = 0;
  let prezzoPasseggero = 0;

  try {
    const tariffe = await getTariffe(corsa.veicolo_id, tipoTariffa);
    prezzoKm = tariffe.prezzoKm;
    prezzoPasseggero = tariffe.prezzoPasseggero;
  } catch (err) {
    console.warn(`⚠️ [PRICING] Tariffe mancanti per veicolo ${corsa.veicolo_id}.`);
  }

  // Se kmTotaliCorsa non fornito, usiamo la distanza della corsa
  const kmTotali = kmTotaliCorsa > 0 ? kmTotaliCorsa : Number(corsa.distanza ?? 0);
  const kmUtente = kmPrenotati > 0 ? kmPrenotati : kmTotali;

  switch (statoSlot) {
    case 'prenotabile': {
      // 1. Verifichiamo se è la prima prenotazione
      const { rows } = await pool.query(
        `SELECT COUNT(*) as num_prenotazioni, COALESCE(SUM(posti_richiesti), 0) as tot_pass_precedenti
         FROM prenotazioni WHERE corsa_id = $1`,
        [corsa.id]
      );
      
      const numPrenotazioni = Number(rows[0].num_prenotazioni);
      const passPrecedenti = Number(rows[0].tot_pass_precedenti);
      
      // PREZZO BASE (Preautorizzazione): euro_km * km_totali
      const prezzoBaseCorsa = kmTotali * prezzoKm;

      if (numPrenotazioni === 0) {
        // PRIMA PRENOTAZIONE: Preautorizza l'intero costo della corsa
        return Math.max(0.10, prezzoBaseCorsa);
      } else {
        // PRENOTAZIONI SUCCESSIVE:
        // Formula: ( (CostoCorsa + (prezzo_pass * pass_succ)) / tot_passeggeri ) * (km_prenotati / km_totali)
        
        const totPasseggeri = passPrecedenti + richiesti;
        const passeggeriSuccessivi = passPrecedenti; // Passeggeri già presenti prima di questo utente
        
        const quotaCondivisa = prezzoBaseCorsa + (prezzoPasseggero * passeggeriSuccessivi);
        const coefficienteTratta = kmUtente / kmTotali;
        
        const prezzoFinale = (quotaCondivisa / totPasseggeri) * coefficienteTratta;
        
        console.log(`💰 [PRICING DINAMICO] CorsaID=${corsa.id} | Base=${prezzoBaseCorsa} | Coeff=${coefficienteTratta.toFixed(2)} | Finale=${prezzoFinale.toFixed(2)}`);
        
        return Math.max(0.10, prezzoFinale);
      }
    }

    case 'pubblicato': {
      return (prezzoPasseggero > 0 ? prezzoPasseggero : prezzoKm) * richiesti;
    }

    default:
      return 0;
  }
}