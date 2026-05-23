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

      const oraPartenza = isCorsa
        ? (item.start_datetime ? new Date(item.start_datetime) : null)
        : (richiesta.start_datetime ? new Date(richiesta.start_datetime) : null);

      let durataMs;

      if (!oraPartenza) {
        durataMs = durataRichiesta;
      } else if (isCorsa) {
        if (item.arrivo_datetime) {
          const arrivo = new Date(item.arrivo_datetime);
          durataMs = arrivo.getTime() - oraPartenza.getTime();
        } else if (item.durata) {
          const [h, m, s] = item.durata.split(':').map(Number);
          durataMs = (h * 3600 + m * 60 + s) * 1000;
        } else {
          durataMs = durataRichiesta;
        }
      } else {
        durataMs = durataRichiesta;
      }

      const durataMinuti = Math.ceil(durataMs / 60000);
      const oraArrivo = oraPartenza
        ? new Date(oraPartenza.getTime() + durataMs)
        : null;

      let localitaOrigine = 'N/D';
      let localitaDestinazione = 'N/D';

      try { localitaOrigine = await getLocalitaSafe(coordOrigine); } catch {}
      try { localitaDestinazione = await getLocalitaSafe(coordDestinazione); } catch {}

      const distanzaKm = isCorsa ? Number(item.distanza ?? 0) : distanzaRichiesta;

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

      return {
        tipo: 'slot',
        id: uuidv4(),
        veicolo_id: item.veicolo_id,
        modello: v?.modello ?? 'N/D',
        tipoVeicolo: v?.tipo ?? 'citycar', // 🔹 aggiunto tipo per icone frontend
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