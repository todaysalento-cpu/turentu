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
 * 1. CALCOLO STIMA PRENOTAZIONE
 * Gestisce sia corse salvate (con ID) che slot di ricerca (senza ID)
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

  const kmTotali = kmTotaliCorsa > 0 ? kmTotaliCorsa : Number(corsa.distanza ?? 0);
  const kmUtente = kmPrenotati > 0 ? kmPrenotati : kmTotali;
  const prezzoBaseCorsa = kmTotali * prezzoKm;

  // --- LOGICA IBRIDA ---
  // Se la corsa ha un ID, interroghiamo il database. Se è uno slot, usiamo i dati in memoria.
  let passPrecedenti = 0;
  
  if (corsa.id) {
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(posti_richiesti), 0) as tot_pass_precedenti
       FROM prenotazioni WHERE corsa_id = $1`,
      [corsa.id]
    );
    passPrecedenti = Number(rows[0].tot_pass_precedenti);
  } else {
    passPrecedenti = Number(corsa.posti_occupati || 0);
  }

  switch (statoSlot) {
    case 'prenotabile': {
      if (passPrecedenti === 0) {
        return Math.max(0.10, prezzoBaseCorsa);
      } else {
        const totPasseggeri = passPrecedenti + richiesti;
        const quotaCondivisa = prezzoBaseCorsa + (prezzoPasseggero * passPrecedenti);
        const coefficienteTratta = kmUtente / kmTotali;
        const prezzoFinale = (quotaCondivisa / totPasseggeri) * coefficienteTratta;
        
        return Math.max(0.10, prezzoFinale);
      }
    }
    case 'pubblicato':
      return (prezzoPasseggero > 0 ? prezzoPasseggero : prezzoKm) * richiesti;
    default:
      return 0;
  }
}

/**
 * 2. CALCOLO QUOTA EQUA (Conguaglio a fine corsa)
 */
export function calcolaQuotaEqua(costoTotaleCorsa, postiRichiesti, totalePasseggeri) {
  if (totalePasseggeri <= 0) return costoTotaleCorsa;
  
  const quotaPerPosto = costoTotaleCorsa / totalePasseggeri;
  const prezzoFinale = quotaPerPosto * postiRichiesti;
  
  return Math.max(0.10, prezzoFinale);
}