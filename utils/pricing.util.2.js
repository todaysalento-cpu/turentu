// utils/pricing.util.js
import { pool } from '../db/db.js'; // Assicurati che punti al tuo pool PostgreSQL

// --- Funzione per ottenere le tariffe dal DB ---
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

// --- Funzione principale per calcolare il prezzo ---
export async function calcolaPrezzo(corsa, postiRichiesti, statoSlot) {
  const kmPercorso = corsa.km ?? 10;
  const richiesti = postiRichiesti ?? 1;

  let prezzoKm = 0;
  let prezzoPasseggero = 0;

  // 🔹 Usa sempre tariffa 'standard'
  const tipoTariffa = 'standard';

  try {
    const tariffe = await getTariffe(corsa.veicolo_id, tipoTariffa);
    prezzoKm = tariffe.prezzoKm;
    prezzoPasseggero = tariffe.prezzoPasseggero;
  } catch (err) {
    console.warn(
      `Tariffe non trovate per veicolo ${corsa.veicolo_id} e tipo ${tipoTariffa}. Prezzo settato a 0.`
    );
    prezzoKm = 0;
    prezzoPasseggero = 0;
  }

  switch (statoSlot) {
    case 'libero':
      return kmPercorso * prezzoKm;

    case 'prenotabile': {
      const postiPrenotati = corsa.posti_prenotati ?? 0;
      const primoPren = corsa.primo_posto ?? 0;
      const totalePasseggeri = postiPrenotati + richiesti;
      const prezzoSuccessivi = prezzoPasseggero * (totalePasseggeri - primoPren);
      const prezzoUnitario = (kmPercorso * prezzoKm + prezzoSuccessivi) / (totalePasseggeri || 1);
      return prezzoUnitario * richiesti;
    }

    case 'pubblicato':
      return prezzoPasseggero * richiesti;

    default:
      return 0;
  }
}
