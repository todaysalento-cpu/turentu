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

export async function calcolaPrezzo(corsa, postiRichiesti, statoSlot) {
  // Conversione sicura dei dati in ingresso
  const kmPercorso = Number(corsa.km ?? corsa.distanza ?? 0);
  const richiesti = Number(postiRichiesti) || 1;
  const tipoTariffa = 'standard';

  let prezzoKm = 0;
  let prezzoPasseggero = 0;

  console.log(`📌 [DEBUG PRICING] Inizio calcolo: VeicoloID=${corsa.veicolo_id}, Stato=${statoSlot}, Km=${kmPercorso}, Richiesti=${richiesti}`);

  try {
    const tariffe = await getTariffe(corsa.veicolo_id, tipoTariffa);
    prezzoKm = tariffe.prezzoKm;
    prezzoPasseggero = tariffe.prezzoPasseggero;
  } catch (err) {
    console.warn(`⚠️ [DEBUG PRICING] Tariffe mancanti per veicolo ${corsa.veicolo_id}.`);
  }

  // Fallback di sicurezza: se la tariffa è 0 ma ci sono km, usiamo 0.50 come base
  const safePrezzoKm = prezzoKm > 0 ? prezzoKm : (kmPercorso > 0 ? 0.50 : 0);

  switch (statoSlot) {
    case 'libero': {
      const prezzoLibero = kmPercorso * safePrezzoKm;
      console.log(`🟢 [LIBERO] Formula: ${kmPercorso} * ${safePrezzoKm} = ${prezzoLibero}`);
      return prezzoLibero;
    }

    case 'prenotabile': {
      // Normalizzazione valori corsa
      const postiPrenotati = Number(corsa.posti_prenotati) || 0;
      const primoPren = Number(corsa.primo_posto) || 0;
      
      // Calcolo totale passeggeri per la condivisione
      const totalePasseggeri = Math.max(1, primoPren + postiPrenotati + richiesti);

      // Calcolo componenti
      const costoBase = kmPercorso * safePrezzoKm;
      // Il costo variabile si applica ai passeggeri oltre al primo (primoPren)
      const costoVariabile = prezzoPasseggero * Math.max(0, (postiPrenotati + richiesti));
      
      const prezzoTotaleVeicolo = costoBase + costoVariabile;
      const prezzoFinale = (prezzoTotaleVeicolo / totalePasseggeri) * richiesti;

      console.log(`🟡 [PRENOTABILE] Dettagli Calcolo:`);
      console.log(`   -> Componenti: PrimoPosto=${primoPren}, Prenotati=${postiPrenotati}, Richiesti=${richiesti}`);
      console.log(`   -> Totale Passeggeri attesi=${totalePasseggeri}`);
      console.log(`   -> Costo Base (Km): ${costoBase} (da ${kmPercorso}km * ${safePrezzoKm})`);
      console.log(`   -> Costo Variabile: ${costoVariabile} (da ${prezzoPasseggero} * ${postiPrenotati + richiesti})`);
      console.log(`   -> Prezzo Totale Veicolo: ${prezzoTotaleVeicolo}`);
      console.log(`   -> Risultato Finale: ${prezzoFinale}`);
      
      return Math.max(0.10, prezzoFinale);
    }

    case 'pubblicato': {
      const prezzoPub = (prezzoPasseggero > 0 ? prezzoPasseggero : safePrezzoKm) * richiesti;
      console.log(`🔵 [PUBBLICATO] Prezzo: ${prezzoPub}`);
      return prezzoPub;
    }

    default:
      console.warn(`⚠️ [WARNING] Stato slot sconosciuto: ${statoSlot}`);
      return 0;
  }
}