import { v4 as uuidv4 } from 'uuid';
import { calcolaPrezzo } from '../../../utils/pricing.util.js';
import { getDurataDistanza, getLocalitaSafe } from '../../../utils/maps.util.js';
import * as CacheModule from '../search.cache.js';
import { getSottoPercorso } from '../engine/availability.engine.js'; 

const safeParseJSON = (str) => {
  try { return typeof str === 'string' ? JSON.parse(str) : (str || []); } 
  catch { return []; }
};

/**
 * Formatta i risultati con ripartizione bilanciata (5 corse + 5 slot)
 */
async function formatResultsAsSlots(richiesta, slotsFiltrati, corseFiltrate, injectedVeicoliMap = null) {
  let durataRichiesta = 0;
  let distanzaRichiesta = 0;

  if (richiesta.coord && richiesta.coordDest) {
    try {
      const result = await getDurataDistanza(richiesta.coord, richiesta.coordDest);
      durataRichiesta = Number(result.durataMs ?? 0);
      distanzaRichiesta = Number(result.distanzaKm ?? 0);
    } catch (err) {
      console.warn('Errore calcolo durata/distanza:', err);
    }
  }

  // --- LOGICA DI RIPARTIZIONE BILANCIATA (5 corse + 5 slot) ---
  const corseNormalizzate = (corseFiltrate || []).map(c => ({ 
    ...c, 
    stato: c.stato === 'libero' ? 'libero' : 'prenotabile' 
  }));

  const slotsNormalizzati = (slotsFiltrati || []).map(s => ({ 
    ...s, 
    stato: 'libero' 
  }));

  // Bilanciamento: prendi fino a 5 corse e 5 slot
  let corseScelte = corseNormalizzate.slice(0, 5);
  let slotScelti = slotsNormalizzati.slice(0, 5);

  // Se una delle due liste è corta, riempi con l'altra per arrivare a 10
  if (corseScelte.length < 5) {
    const needed = 5 - corseScelte.length;
    slotScelti = slotsNormalizzati.slice(0, 5 + needed);
  } else if (slotScelti.length < 5) {
    const needed = 5 - slotScelti.length;
    corseScelte = corseNormalizzate.slice(0, 5 + needed);
  }

  const allItems = [...corseScelte, ...slotScelti].slice(0, CacheModule.TOP_RESULTS || 10);

  // --- PROTEZIONE CACHE ---
  const veicoliMap = injectedVeicoliMap || (typeof CacheModule.getVeicoliMap === 'function' ? CacheModule.getVeicoliMap() : CacheModule.veicoliCache);
  const recensioniCache = typeof CacheModule.getRecensioniCache === 'function' ? CacheModule.getRecensioniCache() : {};

  if (!veicoliMap || typeof veicoliMap.get !== 'function') {
      console.error(`❌ [FORMATTER] Cache non valida!`);
      return [];
  }

  return await Promise.all(
    allItems.map(async (item) => {
      const veicoloId = Number(item.veicolo_id);
      const v = veicoliMap.get(veicoloId);
      
      const isCorsa = item.origine_lat !== undefined;
      const r = recensioniCache[v?.driver_id] || { media: 0, totale: 0 };

      const percorsoVisualizzato = isCorsa && item.percorso_polyline 
        ? getSottoPercorso(item.percorso_polyline, richiesta.coord, richiesta.coordDest)
        : null;

      const localitaOrigine = await getLocalitaSafe(richiesta.coord);
      const localitaDestinazione = await getLocalitaSafe(richiesta.coordDest);

      const oraPartenza = isCorsa
        ? (item.start_datetime ? new Date(item.start_datetime) : new Date())
        : (richiesta.start_datetime ? new Date(richiesta.start_datetime) : new Date());

      let durataMs = isCorsa 
        ? (typeof item.durata === 'string' ? item.durata.split(':').reduce((acc, time) => (60 * acc) + +time, 0) * 1000 : (item.durata || 0) * 1000)
        : durataRichiesta;

      const oraArrivo = new Date(oraPartenza.getTime() + durataMs);
      const distanzaKm = isCorsa ? Number(item.distanza ?? 0) : distanzaRichiesta;
      const postiOccupatiReali = Number(item.picco_occupazione ?? 0);
      const postiTotali = Number(v?.posti_totali ?? 0);

      const prezzo = await calcolaPrezzo(
        { km: distanzaKm, tipo_corsa: item.tipo_corsa, posti_occupati: postiOccupatiReali, posti_totali: postiTotali, veicolo_id: veicoloId },
        richiesta.posti_richiesti,
        item.stato
      );

      return {
        id: item.id || uuidv4(),
        veicolo_id: veicoloId,
        marca: v?.marca ?? null,
        modello: v?.modello ?? null,
        tipoVeicolo: v?.tipo ?? 'citycar',
        servizi: Array.isArray(v?.servizi) ? v.servizi : safeParseJSON(v?.servizi),
        localitaOrigine,
        localitaDestinazione,
        percorsoVisualizzato, 
        oraPartenza: oraPartenza.toISOString(),
        oraArrivo: oraArrivo.toISOString(),
        distanzaKm,
        postiTotali,
        postiOccupati: postiOccupatiReali,
        postiDisponibili: Math.max(0, postiTotali - postiOccupatiReali),
        prezzo: prezzo ?? 0,
        stato: item.stato,
        rating: { media: Number((r.media ?? 0).toFixed(1)), totale: r.totale ?? 0 }
      };
    })
  );
}

export { formatResultsAsSlots as formatResults };