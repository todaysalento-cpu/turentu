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
export async function calcolaPrezzo(corsa, postiRichiesti, statoSlot, kmPrenotati = 0, kmTotaliCorsa = 0) {
  const richiesti = Number(postiRichiesti) || 1;
  const tipoTariffa = 'standard';

  // Valori di default di sicurezza se le tariffe non sono presenti
  let prezzoKm = 0.50;
  let prezzoPasseggero = 2.00;

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
        return Math.max(0.50, prezzoBaseCorsa);
      } else {
        const totPasseggeri = passPrecedenti + richiesti;
        const passeggeriSuccessivi = passPrecedenti;
        const quotaCondivisa = prezzoBaseCorsa + (prezzoPasseggero * passeggeriSuccessivi);
        const coefficienteTratta = kmTotali > 0 ? (kmUtente / kmTotali) : 0;
        const prezzoFinale = (quotaCondivisa / totPasseggeri) * coefficienteTratta;
        
        return Math.max(0.50, prezzoFinale);
      }
    }

    case 'pubblicato': {
      return Math.max(0.50, (prezzoPasseggero > 0 ? prezzoPasseggero : prezzoKm) * richiesti);
    }

    case 'libero': {
      // Logica specifica per gli slot (prezzo calcolato sulla base dei km richiesti)
      const prezzoBase = (prezzoKm * kmUtente) + (prezzoPasseggero * richiesti);
      return Math.max(0.50, prezzoBase);
    }

    default: {
      // Fallback per evitare 0€
      return Math.max(0.50, (prezzoKm * kmUtente));
    }
  }
}