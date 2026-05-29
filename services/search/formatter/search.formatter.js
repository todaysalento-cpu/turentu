import { v4 as uuidv4 } from 'uuid';
import { calcolaPrezzo } from '../../../utils/pricing.util.js';
import { getDurataDistanza, getLocalitaSafe } from '../../../utils/maps.util.js';
import { TOP_RESULTS, veicoliCache, getRecensioniCache } from '../search.cache.js';
import { getSottoPercorso } from '../engine/availability.engine.js'; 

const safeParseJSON = (str) => {
  try { return typeof str === 'string' ? JSON.parse(str) : (str || []); } 
  catch { return []; }
};

/**
 * Formatta i risultati normalizzando i nomi dei campi per il frontend
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
      console.warn('Errore calcolo durata/distanza richiesta:', err);
    }
  }

  const allItems = [
    ...(slotsFiltrati || []).map(s => ({ ...s, stato: 'libero' })),
    ...(corseFiltrate || []).map(c => ({ ...c, stato: c.stato === 'libero' ? 'libero' : 'prenotabile' }))
  ];

  // Utilizziamo la cache Singleton importata direttamente
  const veicoliMap = injectedVeicoliMap || veicoliCache;
  const recensioniCache = getRecensioniCache();

  return await Promise.all(
    allItems.slice(0, TOP_RESULTS).map(async (item) => {
      const veicoloId = Number(item.veicolo_id);
      const v = veicoliMap.get(veicoloId);
      
      // 🔥 LOG DI DEBUG AGGIUNTO
      if (!v) {
        console.warn(`⚠️ [FORMATTER DEBUG] Veicolo ID ${veicoloId} NON trovato.`);
        console.warn(`📊 [FORMATTER DEBUG] Stato Cache: Size=${veicoliMap.size}, Prime 5 chiavi: ${Array.from(veicoliMap.keys()).slice(0, 5).join(', ')}`);
      }

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

      let durataMs;
      if (isCorsa && typeof item.durata === 'string' && item.durata.includes(':')) {
        const parts = item.durata.split(':').map(Number);
        durataMs = (parts[0] * 3600 + parts[1] * 60 + (parts[2] || 0)) * 1000;
      } else if (isCorsa && typeof item.durata === 'number') {
        durataMs = item.durata * 1000;
      } else {
        durataMs = durataRichiesta;
      }

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