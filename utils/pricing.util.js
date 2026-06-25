import { pool } from '../db/db.js';

const TARIFF_DEFAULT = { prezzoKm: 0.50, prezzoPasseggero: 1.00 };
const PREZZO_MINIMO = 0.50;

// Moltiplicatori basati sulla classe di servizio
const CLASSE_MULTIPLIER = {
  EXPRESS: 1.4,
  STANDARD: 1.0,
  SAVER: 0.75
};

const CLASSI_CONFIG = {
  EXPRESS:  { soglia: 0.5, minIndice: 1.5, maxIndice: 99.0 }, 
  STANDARD: { soglia: 0.6, minIndice: 0.3, maxIndice: 1.5 },
  SAVER:    { soglia: 0.9, minIndice: 0.0, maxIndice: 0.3 }
};

const CALCOLA_INDICE = (euro_km, posti) => euro_km / (posti * posti);

async function getDettaglioPool(veicoli_ids) {
  const res = await pool.query(
    `SELECT veicolo_id, euro_km, posti FROM tariffe WHERE veicolo_id = ANY($1)`,
    [veicoli_ids]
  );
  return res.rows.map(r => ({
    id: r.veicolo_id,
    euro_km: Number(r.euro_km),
    posti: Number(r.posti),
    indice: CALCOLA_INDICE(Number(r.euro_km), Number(r.posti))
  }));
}

/**
 * Calcolo prezzo finale
 * @param {Object} corsa - Dati della corsa (inclusa la classe)
 * @param {string} classe - (SAVER, STANDARD, EXPRESS)
 */
export async function calcolaPrezzo(corsa, postiRichiesti, tipo, kmUtente, kmTotali, totPasseggeriCorrenti = 0, classe = 'STANDARD') {
  const tipoValido = ['privata', 'condivisa', 'popbus', 'pop-bus'].includes(tipo) ? tipo : 'standard';
  const richiesti = Math.max(1, Number(postiRichiesti));
  
  // Applichiamo il moltiplicatore in base alla classe
  const multiplier = CLASSE_MULTIPLIER[classe.toUpperCase()] || 1.0;

  console.log(`💰 [PRICING] Classe: ${classe} | Multiplier: ${multiplier} | KM: ${kmUtente.toFixed(2)}`);

  let prezzoCalcolato = 0;

  switch (tipoValido) {
    case 'privata':
    case 'standard':
      const info = corsa.veicolo_id ? await getTariffe(corsa.veicolo_id) : TARIFF_DEFAULT;
      prezzoCalcolato = (info.prezzoKm * kmUtente) * multiplier;
      break;

    case 'condivisa':
      const infoCond = corsa.veicolo_id ? await getTariffe(corsa.veicolo_id) : TARIFF_DEFAULT;
      const totPasseggeriFinale = Math.max(1, totPasseggeriCorrenti + richiesti);
      const costoBase = (infoCond.prezzoKm * kmTotali) + ((totPasseggeriFinale - 1) * infoCond.prezzoPasseggero);
      prezzoCalcolato = ((costoBase / totPasseggeriFinale) * (kmUtente / kmTotali)) * multiplier;
      break;

    case 'popbus':
    case 'pop-bus':
      const poolData = await getDettaglioPool(corsa.veicoli_pool_ids);
      const config = CLASSI_CONFIG[classe.toUpperCase()] || CLASSI_CONFIG.STANDARD;

      const poolFiltrato = poolData.filter(v => 
        v.indice >= config.minIndice && v.indice <= config.maxIndice
      );

      const mezzo = poolFiltrato.length > 0 
        ? poolFiltrato.reduce((prev, curr) => prev.euro_km > curr.euro_km ? prev : curr)
        : poolData.reduce((prev, curr) => prev.euro_km > curr.euro_km ? prev : curr);

      const breakEvenTotale = mezzo.euro_km * kmTotali;
      const targetPasseggeri = Math.max(1, Math.round(mezzo.posti * config.soglia));
      
      prezzoCalcolato = ((breakEvenTotale / targetPasseggeri) * (kmUtente / kmTotali)) * multiplier;
      break;

    default:
      prezzoCalcolato = (0.50 * kmUtente) * multiplier;
  }

  const finale = Math.max(PREZZO_MINIMO, Math.round(prezzoCalcolato * 100) / 100);
  return finale;
}