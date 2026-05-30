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
 * Formatta i risultati garantendo che ogni oggetto contenga i dati necessari al pricing
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

  const corseNormalizzate = (corseFiltrate || []).map(c => ({ ...c, stato: c.stato === 'libero' ? 'libero' : 'prenotabile' }));
  const slotsNormalizzati = (slotsFiltrati || []).map(s => ({ ...s, stato: 'libero' }));

  let corseScelte = corseNormalizzate.slice(0, 5);
  let slotScelti = slotsNormalizzati.slice(0, 10 - corseScelte.length);

  const allItems = [...corseScelte, ...slotScelti].slice(0, CacheModule.TOP_RESULTS || 10);
  const veicoliMap = injectedVeicoliMap || (typeof CacheModule.getVeicoliMap === 'function' ? CacheModule.getVeicoliMap() : CacheModule.veicoliCache);
  const recensioniCache = typeof CacheModule.getRecensioniCache === 'function' ? CacheModule.getRecensioniCache() : {};

  return await Promise.all(
    allItems.map(async (item) => {
      const veicoloId = Number(item.veicolo_id);
      const v = veicoliMap.get(veicoloId);
      const isCorsa = item.origine_lat !== undefined;
      const r = recensioniCache[v?.driver_id] || { media: 0, totale: 0 };

      // Calcolo Date
      let oraPartenza = isCorsa ? new Date(item.start_datetime) : new Date(richiesta.start_datetime || Date.now());
      let durataMs = isCorsa ? (Number(item.durata) || 0) * 1000 : durataRichiesta;
      let oraArrivo = new Date(oraPartenza.getTime() + Number(durataMs));

      // Dati di contesto
      const distanzaKm = isCorsa ? Number(item.distanza ?? 0) : distanzaRichiesta;
      const postiOccupatiReali = Number(item.picco_occupazione ?? 0);
      const postiTotali = Number(v?.posti_totali ?? 0);

      // --- CALCOLO PREZZO CORRETTO ---
      // Passiamo l'item completo per permettere a pricing.util.js di usare l'ID o i dati di backup
      let prezzo = 0;
      try {
        prezzo = await calcolaPrezzo(
          item, // Contiene ID, veicolo_id, distanza, tipo_corsa
          richiesta.posti_richiesti,
          item.stato,
          distanzaKm,
          Number(item.distanza ?? distanzaKm)
        );
      } catch (err) {
        console.error("Errore pricing nel formatter:", err);
        prezzo = 0;
      }

      return {
        id: item.id || uuidv4(),
        veicolo_id: veicoloId,
        marca: v?.marca ?? null,
        modello: v?.modello ?? null,
        tipoVeicolo: v?.tipo ?? 'citycar',
        servizi: Array.isArray(v?.servizi) ? v.servizi : safeParseJSON(v?.servizi),
        localitaOrigine: await getLocalitaSafe(richiesta.coord),
        localitaDestinazione: await getLocalitaSafe(richiesta.coordDest),
        percorsoVisualizzato: isCorsa && item.percorso_polyline ? getSottoPercorso(item.percorso_polyline, richiesta.coord, richiesta.coordDest) : null,
        oraPartenza: oraPartenza.toISOString(),
        oraArrivo: oraArrivo.toISOString(),
        distanzaKm,
        postiTotali,
        postiOccupati: postiOccupatiReali,
        postiDisponibili: Math.max(0, postiTotali - postiOccupatiReali),
        prezzo: Number(prezzo?.toFixed(2)) || 0,
        stato: item.stato,
        rating: { media: Number((r.media ?? 0).toFixed(1)), totale: r.totale ?? 0 }
      };
    })
  );
}

export { formatResultsAsSlots as formatResults };