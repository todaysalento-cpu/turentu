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
 */
export async function calcolaPrezzo(corsa, postiRichiesti, statoSlot, kmPrenotati = 0, kmTotaliCorsa = 0, overrideOccupazione = null) {
  const richiesti = Number(postiRichiesti) || 1;
  const tipoTariffa = 'standard';

  let prezzoKm = 1.00; // Default di sicurezza
  let prezzoPasseggero = 0.00;

  try {
    const tariffe = await getTariffe(corsa.veicolo_id, tipoTariffa);
    prezzoKm = tariffe.prezzoKm;
    prezzoPasseggero = tariffe.prezzoPasseggero;
  } catch (err) {
    console.warn(`⚠️ [PRICING] Tariffe mancanti per veicolo ${corsa.veicolo_id}, uso fallback.`);
  }

  const kmTotali = kmTotaliCorsa > 0 ? kmTotaliCorsa : Number(corsa.distanza ?? 0);
  const kmUtente = kmPrenotati > 0 ? kmPrenotati : kmTotali;

  switch (statoSlot) {
    // LOGICA RIEMPIMENTO (Basata solo su euro_km e soglia)
    case 'da_attivare': {
      const costoTotaleCorsa = kmTotali * prezzoKm;
      const postiSoglia = Number(corsa.posti_soglia || 1);
      
      // Prezzo basato su euro_km distribuito equamente sulla soglia di attivazione
      const prezzoUnitario = postiSoglia > 0 ? (costoTotaleCorsa / postiSoglia) : costoTotaleCorsa;
      
      return Math.max(0.50, prezzoUnitario * richiesti);
    }

    case 'prenotabile': {
      let numPrenotazioni, passPrecedenti;

      if (overrideOccupazione) {
        numPrenotazioni = overrideOccupazione.num;
        passPrecedenti = overrideOccupazione.totPass;
      } else {
        const { rows } = await pool.query(
          `SELECT COUNT(*) as num, COALESCE(SUM(posti_richiesti), 0) as tot 
           FROM prenotazioni WHERE corsa_id = $1`, [corsa.id]
        );
        numPrenotazioni = Number(rows[0].num);
        passPrecedenti = Number(rows[0].tot);
      }
      
      const totPasseggeri = passPrecedenti + richiesti;
      const prezzoBaseCorsa = kmTotali * prezzoKm;
      
      const quotaVariabile = totPasseggeri > 1 ? (prezzoPasseggero * richiesti) : 0;
      const quotaCondivisa = prezzoBaseCorsa + quotaVariabile;
      const coefficienteTratta = kmTotali > 0 ? (kmUtente / kmTotali) : 0;
      
      const prezzoFinale = (quotaCondivisa / totPasseggeri) * coefficienteTratta;
      return Math.max(0.50, prezzoFinale);
    }

    case 'pubblicato': {
      return Math.max(0.50, (prezzoPasseggero > 0 ? prezzoPasseggero : prezzoKm) * richiesti);
    }

    case 'libero': {
      return Math.max(0.50, (prezzoKm * kmUtente) + (prezzoPasseggero * richiesti));
    }

    default: {
      return Math.max(0.50, (prezzoKm * kmUtente));
    }
  }
}