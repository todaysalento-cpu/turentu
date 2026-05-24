// utils/pricing.util.js
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
  const kmPercorso = Number(corsa.km ?? corsa.distanza ?? 0);
  const richiesti = postiRichiesti ?? 1;
  const tipoTariffa = 'standard';

  let prezzoKm = 0;
  let prezzoPasseggero = 0;

  console.log(`📌 Calcolo prezzo [veicolo_id=${corsa.veicolo_id}, stato=${statoSlot}, km=${kmPercorso}]`);

  try {
    const tariffe = await getTariffe(corsa.veicolo_id, tipoTariffa);
    prezzoKm = tariffe.prezzoKm;
    prezzoPasseggero = tariffe.prezzoPasseggero;
  } catch (err) {
    console.warn(`⚠️ Tariffe mancanti per veicolo ${corsa.veicolo_id}.`);
  }

  // Fallback di emergenza: se tutto è 0 ma ci sono km, usiamo una tariffa base simbolica
  const safePrezzoKm = prezzoKm > 0 ? prezzoKm : (kmPercorso > 0 ? 0.50 : 0);

  switch (statoSlot) {
    case 'libero': {
      const prezzoLibero = kmPercorso * safePrezzoKm;
      console.log(`🟢 Stato 'libero': ${kmPercorso} * ${safePrezzoKm} = ${prezzoLibero}`);
      return prezzoLibero;
    }

    case 'prenotabile': {
      const postiPrenotati = corsa.posti_prenotati ?? 0;
      const primoPren = corsa.primo_posto ?? 0;
      const totalePasseggeri = Math.max(1, primoPren + postiPrenotati + richiesti);

      // Calcolo base + variabile
      const costoBase = kmPercorso * safePrezzoKm;
      const costoVariabile = prezzoPasseggero * (totalePasseggeri - primoPren);
      
      // Totale veicolo garantisce che il costo base non venga mai ignorato
      const prezzoTotaleVeicolo = costoBase + costoVariabile;
      const prezzoFinale = (prezzoTotaleVeicolo / totalePasseggeri) * richiesti;

      console.log(`🟡 Stato 'prenotabile': TotaleVeicolo=${prezzoTotaleVeicolo}, PrezzoFinale=${prezzoFinale}`);
      return Math.max(0.10, prezzoFinale); // Prezzo minimo garantito
    }

    case 'pubblicato': {
      const prezzoPub = (prezzoPasseggero > 0 ? prezzoPasseggero : safePrezzoKm) * richiesti;
      return prezzoPub;
    }

    default:
      return 0;
  }
}