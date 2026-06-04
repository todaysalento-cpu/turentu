import { pool } from '../db/db.js';

export async function getTariffe(veicolo_id, tipo) {
  console.log(`🔍 [PRICING] Query DB | Veicolo: ${veicolo_id}, Tipo: ${tipo}`);
  
  try {
    const res = await pool.query(
      'SELECT euro_km, prezzo_passeggero FROM tariffe WHERE veicolo_id = $1 AND tipo = $2 LIMIT 1',
      [veicolo_id, tipo]
    );
    
    if (res.rows.length === 0) {
      console.warn(`⚠️ [PRICING] Nessuna tariffa trovata per Veicolo ${veicolo_id}, Tipo: ${tipo}`);
      throw new Error('Tariffa non trovata');
    }
    
    const tariffa = {
      prezzoKm: Number(res.rows[0].euro_km) || 0,
      prezzoPasseggero: Number(res.rows[0].prezzo_passeggero) || 0
    };
    
    console.log(`✅ [PRICING] Tariffa caricata:`, tariffa);
    return tariffa;
  } catch (error) {
    console.error(`❌ [PRICING] Errore DB:`, error.message);
    throw error;
  }
}

/**
 * Motore di Calcolo Prezzi Turentu (Versione Debug)
 */
export async function calcolaPrezzo(corsa, postiRichiesti, tipo, kmUtente, kmTotali, totPasseggeriCorrenti = 0) {
  const richiesti = Math.max(1, Number(postiRichiesti) || 1);
  const uKm = Number(kmUtente) || 0;
  const tKm = Number(kmTotali) || 0;

  console.log(`⚙️ [PRICING] Calcolo richiesto | Tipo: ${tipo} | KmUtente: ${uKm} | KmTotali: ${tKm}`);

  try {
    const { prezzoKm, prezzoPasseggero } = await getTariffe(corsa.veicolo_id, tipo);
    const PREZZO_MINIMO = 0.50; // In euro (calcolato su float, poi arrotondato)
    let prezzoFinale = 0;

    switch (tipo) {
      case 'privata':
        prezzoFinale = prezzoKm * uKm;
        console.log(`🧮 [PRICING] Formula Privata: ${prezzoKm} * ${uKm} = ${prezzoFinale}`);
        break;

      case 'condivisa':
        const totPasseggeriFinale = Math.max(1, Number(totPasseggeriCorrenti) + richiesti);
        const passeggeriSuccessivi = Math.max(0, totPasseggeriFinale - 1);
        
        const costoBase = (prezzoKm * tKm) + (passeggeriSuccessivi * prezzoPasseggero);
        prezzoFinale = (costoBase / totPasseggeriFinale) * (uKm / tKm);
        console.log(`🧮 [PRICING] Formula Condivisa: (${prezzoKm}*${tKm} + ${passeggeriSuccessivi}*${prezzoPasseggero}) / ${totPasseggeriFinale} * (${uKm}/${tKm}) = ${prezzoFinale}`);
        break;

      case 'riempimento':
        const soglia = Math.max(1, Number(corsa.posti_soglia || 1));
        prezzoFinale = ((prezzoKm * tKm) / soglia) * richiesti;
        console.log(`🧮 [PRICING] Formula Riempimento: ((${prezzoKm}*${tKm})/${soglia}) * ${richiesti} = ${prezzoFinale}`);
        break;

      default:
        prezzoFinale = prezzoKm * uKm;
        console.log(`🧮 [PRICING] Default: ${prezzoFinale}`);
    }

    const risultato = Math.max(PREZZO_MINIMO, Math.round(prezzoFinale * 100) / 100);
    console.log(`🏁 [PRICING] Risultato finale arrotondato: ${risultato} €`);
    return risultato;

  } catch (err) {
    console.error(`💥 [PRICING] Errore critico nel calcolo:`, err);
    return 0.50; // Fallback di sicurezza per non bloccare l'UI
  }
}