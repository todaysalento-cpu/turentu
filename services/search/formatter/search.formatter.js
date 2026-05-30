import { v4 as uuidv4 } from 'uuid';
import * as turf from '@turf/turf';
import { calcolaPrezzo } from '../../../utils/pricing.util.js';
import { getDurataDistanza, getLocalitaSafe } from '../../../utils/maps.util.js';
import * as CacheModule from '../search.cache.js';
import { getSottoPercorso } from '../engine/availability.engine.js'; 

const safeParseJSON = (str) => {
  try { return typeof str === 'string' ? JSON.parse(str) : (str || []); } 
  catch { return []; }
};

/**
 * Helper per convertire l'interval Postgres in millisecondi
 */
function parseIntervalToMs(durata) {
  if (typeof durata === 'number') return durata * 1000;
  if (typeof durata === 'object' && durata !== null) {
    const h = durata.hours || 0;
    const m = durata.minutes || 0;
    const s = durata.seconds || 0;
    return (h * 3600 + m * 60 + s) * 1000;
  }
  if (typeof durata === 'string') {
    const parts = durata.split(':').map(Number);
    if (parts.length === 3) return ((parts[0] * 3600) + (parts[1] * 60) + parts[2]) * 1000;
  }
  return 0;
}

async function formatResultsAsSlots(richiesta, slotsFiltrati, corseFiltrate, injectedVeicoliMap = null) {
  let durataRichiesta = 0;
  let distanzaRichiesta = 0;

  if (richiesta.coord && richiesta.coordDest) {
    try {
      const result = await getDurataDistanza(richiesta.coord, richiesta.coordDest);
      durataRichiesta = Number(result.durataMs ?? 0);
      distanzaRichiesta = Number(result.distanzaKm ?? 0);
    } catch (err) { console.warn('Errore calcolo durata/distanza:', err); }
  }

  const corseNormalizzate = (corseFiltrate || []).map(c => ({ ...c, stato: c.stato === 'libero' ? 'libero' : 'prenotabile' }));
  const slotsNormalizzati = (slotsFiltrati || []).map(s => ({ ...s, stato: 'libero' }));

  const allItems = [...corseNormalizzate.slice(0, 5), ...slotsNormalizzati.slice(0, 5)].slice(0, CacheModule.TOP_RESULTS || 10);
  const veicoliMap = injectedVeicoliMap || (typeof CacheModule.getVeicoliMap === 'function' ? CacheModule.getVeicoliMap() : CacheModule.veicoliCache);
  const recensioniCache = typeof CacheModule.getRecensioniCache === 'function' ? CacheModule.getRecensioniCache() : {};

  return await Promise.all(
    allItems.map(async (item) => {
      const veicoloId = Number(item.veicolo_id);
      const v = veicoliMap.get(veicoloId);
      const isCorsa = !!item.start_datetime;
      const r = recensioniCache[v?.driver_id] || { media: 0, totale: 0 };

      // Normalizzazione Durata Totale
      const durataTotaleMs = isCorsa ? parseIntervalToMs(item.durata) : durataRichiesta;
      const velMediaMsPerKm = isCorsa ? (durataTotaleMs / Number(item.distanza || 1)) : 0;

      // --- CALCOLO ORARIO PARTENZA/ARRIVO DINAMICO ---
      let oraPartenza = new Date(item.start_datetime || Date.now());
      let durataSegmentoMs = durataTotaleMs;

      if (isCorsa && item.decodedCoords?.length > 1) {
        try {
          const line = turf.lineString(item.decodedCoords);
          const puntoSalita = turf.point([richiesta.coord.lon, richiesta.coord.lat]);
          const puntoDiscesa = turf.point([richiesta.coordDest.lon, richiesta.coordDest.lat]);
          
          const snapSalita = turf.nearestPointOnLine(line, puntoSalita);
          const snapDiscesa = turf.nearestPointOnLine(line, puntoDiscesa);
          
          const distOrigineToSalita = turf.length(turf.lineSlice(turf.point(line.geometry.coordinates[0]), snapSalita, line), { units: 'kilometers' });
          oraPartenza = new Date(new Date(item.start_datetime).getTime() + (distOrigineToSalita * velMediaMsPerKm));
          
          const distSegmento = turf.length(turf.lineSlice(snapSalita, snapDiscesa, line), { units: 'kilometers' });
          durataSegmentoMs = distSegmento * velMediaMsPerKm;
        } catch (e) {
          console.error("Errore calcolo dinamico:", e);
        }
      } else {
        oraPartenza = new Date(richiesta.start_datetime || Date.now());
      }

      const oraArrivo = new Date(oraPartenza.getTime() + durataSegmentoMs);

      // --- CALCOLO PREZZO ---
      let prezzo = 0;
      try {
        prezzo = await calcolaPrezzo(item, richiesta.posti_richiesti, item.stato, distanzaRichiesta, Number(item.distanza));
      } catch (err) { prezzo = 0; }

      return {
        id: item.id || uuidv4(),
        veicolo_id: veicoloId,
        marca: v?.marca ?? null,
        modello: v?.modello ?? null,
        localitaOrigine: await getLocalitaSafe(richiesta.coord),
        localitaDestinazione: await getLocalitaSafe(richiesta.coordDest),
        percorsoVisualizzato: isCorsa && item.decodedCoords ? getSottoPercorso(item.decodedCoords, richiesta.coord, richiesta.coordDest) : null,
        oraPartenza: oraPartenza.toISOString(),
        oraArrivo: oraArrivo.toISOString(),
        distanzaKm: isCorsa ? Number(item.distanza ?? 0) : distanzaRichiesta,
        prezzo: Number(prezzo?.toFixed(2)) || 0,
        stato: item.stato,
        // Utilizzo del valore calcolato dinamicamente nel motore di ricerca
        postiDisponibili: Number(item.postiDisponibili ?? 0),
        rating: { media: Number((r.media ?? 0).toFixed(1)), totale: r.totale ?? 0 }
      };
    })
  );
}

export { formatResultsAsSlots as formatResults };