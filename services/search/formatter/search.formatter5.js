// services/search/formatter/search.formatter.js
import { v4 as uuidv4 } from 'uuid';
import { calcolaPrezzo } from '../../../utils/pricing.util.js';
import { getDurataDistanza, getLocalitaSafe } from '../../../utils/maps.util.js';
import { TOP_RESULTS } from '../search.cache.js';

const safeParseJSON = (str) => {
  try { return JSON.parse(str); } 
  catch { return []; }
};

async function formatResultsAsSlots(richiesta, slotsFiltrati, corseFiltrate, veicoliCache) {
  let durataRichiesta = 0;
  let distanzaRichiesta = 0;

  if (richiesta.coord && richiesta.coordDest) {
    try {
      const result = await getDurataDistanza(richiesta.coord, richiesta.coordDest);
      durataRichiesta = Number(result.durataMs ?? 0);
      distanzaRichiesta = Number(result.distanzaKm ?? 0);

      console.log('🔹 DURATA RICHIESTA CALCOLATA:', durataRichiesta, 'ms');
      console.log('🔹 DISTANZA RICHIESTA CALCOLATA:', distanzaRichiesta, 'km');
    } catch (err) {
      console.warn('Errore calcolo durata/distanza richiesta:', err);
    }
  }

  const allItems = [
    ...slotsFiltrati.map(s => ({ ...s, stato: 'libero' })),
    ...corseFiltrate.map(c => ({ ...c, stato: c.stato === 'libero' ? 'libero' : 'prenotabile' }))
  ];

  return await Promise.all(
    allItems.slice(0, TOP_RESULTS).map(async (item) => {
      const v = veicoliCache[item.veicolo_id];
      const isCorsa = item.origine_lat !== undefined;

      const coordOrigine = isCorsa
        ? { lat: item.origine_lat, lon: item.origine_lon }
        : richiesta.coord;

      const coordDestinazione = isCorsa
        ? { lat: item.dest_lat, lon: item.dest_lon }
        : richiesta.coordDest;

      // 🔹 Calcolo durata coerente usando arrivo_datetime se disponibile
      let durataMs;
      const oraPartenza = new Date(isCorsa ? item.start_datetime : richiesta.start_datetime);

      if (isCorsa) {
        if (item.arrivo_datetime) {
          durataMs = new Date(item.arrivo_datetime).getTime() - oraPartenza.getTime();
        } else if (item.durata) {
          // parsare 'HH:MM:SS' in ms
          const [h, m, s] = item.durata.split(':').map(Number);
          durataMs = (h * 3600 + m * 60 + s) * 1000;
        } else {
          durataMs = durataRichiesta;
        }
      } else {
        durataMs = durataRichiesta;
      }

      const durataMinuti = Math.ceil(durataMs / 60000);
      const oraArrivo = new Date(oraPartenza.getTime() + durataMs);

      let localitaOrigine = 'N/D';
      let localitaDestinazione = 'N/D';
      try { localitaOrigine = await getLocalitaSafe(coordOrigine); } catch {}
      try { localitaDestinazione = await getLocalitaSafe(coordDestinazione); } catch {}

      const distanzaKm = isCorsa ? Number(item.distanza ?? 0) : distanzaRichiesta;

      // 🔹 LOG DETTAGLI SLOT / CORSA
      console.log('🔹 SLOT / CORSA DEBUG:', {
        veicolo_id: item.veicolo_id,
        isCorsa,
        itemId: item.id ?? 'N/D',
        start_datetime: item.start_datetime,
        arrivo_datetime: item.arrivo_datetime ?? 'N/D',
        durataOriginale: item.durata,
        durataMs,
        durataMinuti,
        oraPartenza,
        oraArrivo,
        coordOrigine,
        coordDestinazione,
        distanzaKm
      });

      // 🔹 LOG PRIMA DEL CALCOLO PREZZO
      const tipoTariffa = item.tipo_corsa ?? item.stato ?? 'libero';
      console.log('🔹 Calcolo prezzo INPUT:', {
        veicolo_id: item.veicolo_id,
        tipoTariffa,
        distanzaKm,
        postiRichiesti: richiesta.posti_richiesti,
        statoSlot: item.stato,
        posti_prenotati: item.posti_prenotati ?? 0,
        primo_posto: item.primo_posto ?? 0,
        durataMinuti
      });

      const prezzo = await calcolaPrezzo(
        {
          km: distanzaKm,
          tipo_corsa: item.tipo_corsa,
          posti_prenotati: item.posti_prenotati ?? 0,
          primo_posto: item.primo_posto ?? 0,
          veicolo_id: item.veicolo_id
        },
        richiesta.posti_richiesti,
        item.stato
      );

      // 🔹 LOG DOPO CALCOLO PREZZO
      console.log('🔹 Prezzo calcolato:', prezzo);

      return {
        tipo: 'slot',
        id: uuidv4(),
        veicolo_id: item.veicolo_id,
        modello: v?.modello ?? 'N/D',
        servizi: Array.isArray(v?.servizi) ? v.servizi : safeParseJSON(v?.servizi),
        coordOrigine,
        coordDestinazione,
        localitaOrigine,
        localitaDestinazione,
        oraPartenza,
        oraArrivo,
        durataMs,
        durataMinuti,
        distanzaKm,
        postiTotali: v?.posti_totali ?? 0,
        postiRichiesti: richiesta.posti_richiesti,
        prezzo,
        stato: item.stato,
        corseCompatibili: isCorsa ? [item] : []
      };
    })
  );
}

export { formatResultsAsSlots as formatResults };