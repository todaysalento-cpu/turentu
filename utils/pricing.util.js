// utils/pricing.util.js
import { pool } from '../db/db.js'; 

export async function getTariffe(veicolo_id, tipo) {
  const res = await pool.query(
    'SELECT euro_km, prezzo_passeggero FROM tariffe WHERE veicolo_id = $1 AND tipo = $2 LIMIT 1',
    [veicolo_id, tipo]
  );
  if (res.rows.length === 0) throw new Error('Tariffa non trovata');
  return {
    prezzoKm: Number(res.rows[0].euro_km),
    prezzoPasseggero: Number(res.rows[0].prezzo_passeggero)
  };
}

export async function calcolaPrezzo(corsa, postiRichiesti, statoSlot) {
  const kmPercorso = corsa.km != null
    ? Number(corsa.km)
    : corsa.distanza != null
    ? Number(corsa.distanza)
    : 0;

  const richiesti = postiRichiesti ?? 1;

  let prezzoKm = 0;
  let prezzoPasseggero = 0;
  const tipoTariffa = 'standard';

  console.log(`📌 Calcolo prezzo per veicolo_id=${corsa.veicolo_id}, postiRichiesti=${richiesti}, statoSlot=${statoSlot}, kmPercorso=${kmPercorso}`);

  try {
    const tariffe = await getTariffe(corsa.veicolo_id, tipoTariffa);
    prezzoKm = tariffe.prezzoKm;
    prezzoPasseggero = tariffe.prezzoPasseggero;
    console.log(`💰 Tariffe recuperate: prezzoKm=${prezzoKm}, prezzoPasseggero=${prezzoPasseggero}`);
  } catch (err) {
    console.warn(`⚠️ Tariffe non trovate per veicolo ${corsa.veicolo_id} e tipo ${tipoTariffa}. Prezzo settato a 0.`);
    prezzoKm = 0;
    prezzoPasseggero = 0;
  }

  switch (statoSlot) {
    case 'libero': {
      const prezzoLibero = kmPercorso * prezzoKm;
      console.log(`🟢 Stato 'libero': kmPercorso * prezzoKm = ${kmPercorso} * ${prezzoKm} = ${prezzoLibero}`);
      return prezzoLibero;
    }

    case 'prenotabile': {
      const postiPrenotati = corsa.posti_prenotati ?? 0;
      const primoPren = corsa.primo_posto ?? 0;

      // ✅ Totale passeggeri = primo posto + posti già prenotati + richiesti della prenotazione corrente
      const totalePasseggeri = primoPren + postiPrenotati + richiesti;

      const prezzoSuccessivi = prezzoPasseggero * (totalePasseggeri - primoPren);
      const prezzoUnitario = (kmPercorso * prezzoKm + prezzoSuccessivi) / (totalePasseggeri || 1);
      const prezzoFinale = prezzoUnitario * richiesti;

      console.log(`🟡 Stato 'prenotabile': postiPrenotati=${postiPrenotati}, primoPren=${primoPren}, totalePasseggeri=${totalePasseggeri}`);
      console.log(`   prezzoSuccessivi = ${prezzoSuccessivi}, prezzoUnitario = ${prezzoUnitario}, prezzoFinale = ${prezzoFinale}`);

      return prezzoFinale;
    }

    case 'pubblicato': {
      const prezzoPub = prezzoPasseggero * richiesti;
      console.log(`🔵 Stato 'pubblicato': prezzoPasseggero * richiesti = ${prezzoPasseggero} * ${richiesti} = ${prezzoPub}`);
      return prezzoPub;
    }

    default:
      console.log(`⚪ Stato sconosciuto '${statoSlot}', prezzo = 0`);
      return 0;
  }
}