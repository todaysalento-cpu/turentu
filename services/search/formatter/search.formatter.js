import { v4 as uuidv4 } from 'uuid';
import { calcolaPrezzo } from '../../../utils/pricing.util.js';
import { getDurataDistanza, getLocalitaSafe } from '../../../utils/maps.util.js';
import { TOP_RESULTS, veicoliCache, getRecensioniCache } from '../search.cache.js';
import { getSottoPercorso } from '../engine/availability.engine.js'; 

const safeParseJSON = (str) => {
  try { return typeof str === 'string' ? JSON.parse(str) : (str || []); } 
  catch { return []; }
};

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

  const allItems = [
    ...(slotsFiltrati || []).map(s => ({ ...s, stato: 'libero' })),
    ...(corseFiltrate || []).map(c => ({ ...c, stato: c.stato === 'libero' ? 'libero' : 'prenotabile' }))
  ];

  const veicoliMap = injectedVeicoliMap || veicoliCache;
  const recensioniCache = getRecensioniCache();

  // 🔥 DIAGNOSTICA STATO CACHE (Eseguita una sola volta)
  console.log(`🔍 [FORMATTER] Cache Size: ${veicoliMap.size}`);
  if (veicoliMap.size > 0) {
      const sampleKey = veicoliMap.keys().next().value;
      console.log(`🔍 [FORMATTER] Tipo chiave in cache: ${typeof sampleKey}, Esempio: ${sampleKey}`);
  }

  return await Promise.all(
    allItems.slice(0, TOP_RESULTS).map(async (item) => {
      // Normalizziamo l'ID
      const veicoloId = Number(item.veicolo_id);
      const v = veicoliMap.get(veicoloId);
      
      // 🔥 LOG DI DEBUG DETTAGLIATO
      if (!v) {
        console.warn(`⚠️ [FORMATTER DEBUG] ID ${veicoloId} (tipo: ${typeof veicoloId}) non trovato.`);
        // Verifica se esiste un ID simile (per evitare problemi di stringhe numeriche)
        const keys = Array.from(veicoliMap.keys());
        const found = keys.find(k => Number(k) === veicoloId);
        if (found) console.warn(`💡 [FORMATTER DEBUG] Trovata chiave corrispondente ma diversa: ${typeof found} ${found}`);
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