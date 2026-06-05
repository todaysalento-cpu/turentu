import { pool } from '../db/db.js';

const SOGLIA_ATTIVAZIONE_PERCENT = 0.6;

export async function getTariffe(veicolo_id, tipo) {
  const tipoDaCercare = (tipo === 'pop-bus') ? 'standard' : tipo;
  
  const res = await pool.query(
    'SELECT euro_km, prezzo_passeggero FROM tariffe WHERE veicolo_id = $1 AND tipo = $2 LIMIT 1',
    [veicolo_id, tipoDaCercare]
  );
  
  if (res.rows.length === 0) throw new Error(`Tariffa non trovata per veicolo ${veicolo_id} e tipo ${tipoDaCercare}`);
  
  return {
    prezzoKm: Number(res.rows[0].euro_km) || 0,
    prezzoPasseggero: Number(res.rows[0].prezzo_passeggero) || 0
  };
}

export async function calcolaPrezzo(corsa, postiRichiesti, tipo, kmUtente, kmTotali, totPasseggeriCorrenti = 0) {
  const richiesti = Math.max(1, Number(postiRichiesti));
  const { prezzoKm, prezzoPasseggero } = await getTariffe(corsa.veicolo_id, tipo);

  const PREZZO_MINIMO = 0.50; // Corretto a 0.50 per rappresentare 50 centesimi

  // Log per debug del calcolo
  console.log(`[Pricing Engine] Tipo: ${tipo}, KmUtente: ${kmUtente}, KmTotali: ${kmTotali}, PrezzoKm: ${prezzoKm}`);

  let prezzoCalcolato = 0;

  switch (tipo) {
    case 'privata':
      prezzoCalcolato = prezzoKm * kmUtente;
      break;

    case 'condivisa':
      const totPasseggeriFinale = Math.max(1, totPasseggeriCorrenti + richiesti);
      const passeggeriSuccessivi = Math.max(0, totPasseggeriFinale - 1);
      const costoBase = (prezzoKm * kmTotali) + (passeggeriSuccessivi * prezzoPasseggero);
      prezzoCalcolato = (costoBase / totPasseggeriFinale) * (kmUtente / kmTotali);
      break;

    case 'riempimento':
      const soglia = Math.max(1, Number(corsa.posti_soglia || 1));
      const prezzoUnitarioSoglia = (prezzoKm * kmTotali) / soglia;
      prezzoCalcolato = prezzoUnitarioSoglia * richiesti;
      break;

    case 'pop-bus':
      // FORMULA: (kmUtente * euro_km) / (posti_totali * soglia)
      const postiTotali = Number(corsa.posti_totali || 1);
      prezzoCalcolato = (kmUtente * prezzoKm) / (postiTotali * SOGLIA_ATTIVAZIONE_PERCENT);
      console.log(`[Pricing Engine] Dettaglio Pop-Bus: KmUtente=${kmUtente}, PrezzoKm=${prezzoKm}, PostiTot=${postiTotali} -> Prezzo: ${prezzoCalcolato}`);
      break;

    default:
      prezzoCalcolato = prezzoKm * kmUtente;
  }

  const risultatoFinale = Math.max(PREZZO_MINIMO, Math.round(prezzoCalcolato * 100) / 100);
  
  console.log(`[Pricing Engine] Risultato Finale: ${risultatoFinale}`);
  return risultatoFinale;
}