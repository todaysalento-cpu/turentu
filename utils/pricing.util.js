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
 * 1. CALCOLO STIMA PRENOTAZIONE (Per la Pre-autorizzazione)
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

  switch (statoSlot) {
    case 'prenotabile': {
      const { rows } = await pool.query(
        `SELECT COUNT(*) as num_prenotazioni, COALESCE(SUM(posti_richiesti), 0) as tot_pass_precedenti
         FROM prenotazioni WHERE corsa_id = $1`,
        [corsa.id]
      );
      
      const numPrenotazioni = Number(rows[0].num_prenotazioni);
      const passPrecedenti = Number(rows[0].tot_pass_precedenti);
      const prezzoBaseCorsa = kmTotali * prezzoKm;

      if (numPrenotazioni === 0) {
        return Math.max(0.10, prezzoBaseCorsa);
      } else {
        const totPasseggeri = passPrecedenti + richiesti;
        const quotaCondivisa = prezzoBaseCorsa + (prezzoPasseggero * passPrecedenti);
        const coefficienteTratta = kmUtente / kmTotali;
        const prezzoFinale = (quotaCondivisa / totPasseggeri) * coefficienteTratta;
        
        console.log(`💰 [PRICING STIMA] CorsaID=${corsa.id} | Finale=${prezzoFinale.toFixed(2)}`);
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
 * 2. CALCOLO QUOTA EQUA (Per il Conguaglio a fine corsa)
 * @param {number} costoTotaleCorsa - Distanza totale * tariffa Km
 * @param {number} postiRichiesti - Posti prenotati da questo specifico utente
 * @param {number} totalePasseggeri - Numero totale di passeggeri che hanno viaggiato
 */
export function calcolaQuotaEqua(costoTotaleCorsa, postiRichiesti, totalePasseggeri) {
  if (totalePasseggeri <= 0) return costoTotaleCorsa;
  
  // La quota è ripartita equamente per posto occupato
  const quotaPerPosto = costoTotaleCorsa / totalePasseggeri;
  const prezzoFinale = quotaPerPosto * postiRichiesti;
  
  console.log(`⚖️ [PRICING CONGUAGLIO] TotaleCorsa=${costoTotaleCorsa} | TotalePass=${totalePasseggeri} | QuotaFinale=${prezzoFinale.toFixed(2)}`);
  return Math.max(0.10, prezzoFinale);
}