// services/search/formatter/search.formatter.js
import { v4 as uuidv4 } from 'uuid';
import { calcolaPrezzo } from '../../../utils/pricing.util.js';
import { getDurataDistanza, getLocalitaSafe } from '../../../utils/maps.util.js';
import { TOP_RESULTS } from '../search.cache.js';

// Funzione di utilità per fare il parse sicuro di JSON
const safeParseJSON = (str) => {
  try {
    return JSON.parse(str);
  } catch {
    return [];
  }
};

/**
 * Format results di slots e corse
 */
export async function formatResults(richiesta, slotsFiltrati, corseFiltrate, veicoliCache) {
  // Calcola durata e distanza della richiesta
  let durataRichiesta = 0;
  let distanzaRichiesta = 0;
  if (richiesta.coord && richiesta.coordDest) {
    try {
      const result = await getDurataDistanza(richiesta.coord, richiesta.coordDest);
      durataRichiesta = Number(result.durataMs ?? 0);
      distanzaRichiesta = Number(result.distanzaKm ?? 0);
    } catch (err) {
      console.warn('Errore calcolo durata/distanza richiesta:', err);
      durataRichiesta = 0;
      distanzaRichiesta = 0;
    }
  }

  // =========================
  // SLOT LIBERI
  // =========================
  const slotResults = await Promise.all(
    slotsFiltrati.slice(0, TOP_RESULTS).map(async (slot) => {
      const v = veicoliCache[slot.veicolo_id];

      const oraPartenza = new Date(richiesta.start_datetime);
      const oraArrivo = new Date(oraPartenza.getTime() + durataRichiesta);

      // Recupera località in modo sicuro, fallback 'N/D' se fallisce
      let localitaOrigine = 'N/D';
      let localitaDestinazione = 'N/D';
      try {
        localitaOrigine = await getLocalitaSafe(richiesta.coord);
      } catch {}
      try {
        localitaDestinazione = await getLocalitaSafe(richiesta.coordDest);
      } catch {}

      // Calcolo prezzo slot
      const prezzo = await calcolaPrezzo(
        { km: distanzaRichiesta, tipo_corsa: 'libero', posti_prenotati: 0, primo_posto: 0 },
        Number(v?.euro_km ?? 1),
        1,
        richiesta.posti_richiesti,
        'libero'
      );

      return {
        tipo: 'slot',
        id: uuidv4(),
        veicolo_id: v?.id ?? 'N/D',
        modello: v?.modello ?? 'N/D',
        servizi: Array.isArray(v?.servizi) ? v.servizi : safeParseJSON(v?.servizi),
        coordOrigine: richiesta.coord,
        coordDestinazione: richiesta.coordDest,
        localitaOrigine,
        localitaDestinazione,
        oraPartenza,
        oraArrivo,
        durataMs: durataRichiesta,
        distanzaKm: distanzaRichiesta,
        postiTotali: v?.posti_totali ?? 0,
        postiRichiesti: richiesta.posti_richiesti,
        prezzo,
        euro_km: Number(v?.euro_km ?? 1),
        stato: 'libero',
        corseCompatibili: []
      };
    })
  );

  // =========================
  // CORSE COMPATIBILI
  // =========================
  const corsaResults = await Promise.all(
    corseFiltrate.slice(0, TOP_RESULTS).map(async (corsa) => {
      const v = veicoliCache[corsa.veicolo_id];

      const oraPartenza = new Date(corsa.start_datetime);
      const durataMsCorsa = Number(corsa.durata ?? 0) * 1000;
      const oraArrivo = new Date(oraPartenza.getTime() + durataMsCorsa);

      // Recupera località in modo sicuro
      let localitaOrigine = 'N/D';
      let localitaDestinazione = 'N/D';
      try {
        localitaOrigine = await getLocalitaSafe({ lat: corsa.origine_lat, lon: corsa.origine_lon });
      } catch {}
      try {
        localitaDestinazione = await getLocalitaSafe({ lat: corsa.dest_lat, lon: corsa.dest_lon });
      } catch {}

      const prezzoPasseggero = Number(v?.prezzo_passeggero ?? 1);

      const prezzo = await calcolaPrezzo(
        {
          km: Number(corsa.distanza ?? 0),
          tipo_corsa: corsa.tipo_corsa ?? 'condiviso',
          posti_prenotati: corsa.posti_prenotati ?? 0,
          primo_posto: corsa.primo_posto ?? 0
        },
        Number(corsa.euro_km ?? v?.euro_km ?? 1),
        prezzoPasseggero,
        richiesta.posti_richiesti,
        corsa.stato === 'libero' ? 'libero' : 'condiviso'
      );

      return {
        tipo: 'corsa',
        id: uuidv4(),
        veicolo_id: corsa.veicolo_id,
        modello: v?.modello ?? 'N/D',
        servizi: Array.isArray(v?.servizi) ? v.servizi : safeParseJSON(v?.servizi),
        coordOrigine: { lat: corsa.origine_lat, lon: corsa.origine_lon },
        coordDestinazione: { lat: corsa.dest_lat, lon: corsa.dest_lon },
        localitaOrigine,
        localitaDestinazione,
        oraPartenza,
        oraArrivo,
        durataMs: durataMsCorsa,
        distanzaKm: Number(corsa.distanza ?? 0),
        euro_km: Number(v?.euro_km ?? 1),
        prezzo,
        stato: corsa.stato ?? 'prenotabile',
        corseCompatibili: [corsa]
      };
    })
  );

  return [...slotResults, ...corsaResults];
}
