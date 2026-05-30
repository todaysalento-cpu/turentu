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
 * Calcolo Prezzo Dinamico (Aggiornato)
 */
export async function calcolaPrezzo(corsa, postiRichiesti, statoSlot, kmPrenotati = 0, kmTotaliCorsa = 0) {
  const richiesti = Number(postiRichiesti) || 1;
  const tipoTariffa = 'standard';

  // Valori di default di sicurezza
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
        // PRIMA PRENOTAZIONE: Nessun sovrapprezzo per passeggero
        return Math.max(0.50, prezzoBaseCorsa);
      } else {
        // PRENOTAZIONI SUCCESSIVE:
        // Applico il prezzoPasseggero moltiplicato per i passeggeri aggiuntivi (richiesti)
        const totPasseggeri = passPrecedenti + richiesti;
        const quotaAggiuntiva = prezzoPasseggero * richiesti;

        const quotaCondivisa = prezzoBaseCorsa + quotaAggiuntiva;
        const coefficienteTratta = kmTotali > 0 ? (kmUtente / kmTotali) : 0;
        
        // Divisione equa distribuita su tutti i passeggeri (precedenti + nuovi)
        const prezzoFinale = (quotaCondivisa / totPasseggeri) * coefficienteTratta;
        
        return Math.max(0.50, prezzoFinale);
      }
    }

    case 'pubblicato': {
      return Math.max(0.50, (prezzoPasseggero > 0 ? prezzoPasseggero : prezzoKm) * richiesti);
    }

    case 'libero': {
      const prezzoBase = (prezzoKm * kmUtente) + (prezzoPasseggero * richiesti);
      return Math.max(0.50, prezzoBase);
    }

    default: {
      return Math.max(0.50, (prezzoKm * kmUtente));
    }
  }
}