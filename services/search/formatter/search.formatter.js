import { v4 as uuidv4 } from 'uuid';
import { calcolaPrezzo } from '../../../utils/pricing.util.js';
import { getDurataDistanza, getLocalitaSafe } from '../../../utils/maps.util.js';
import { TOP_RESULTS, getVeicoliMap, getRecensioniCache } from '../search.cache.js';
// Importa la funzione di slicing che abbiamo definito nel motore geometrico
import { getSottoPercorso } from '../engine/availability.engine.js'; 

const safeParseJSON = (str) => {
  try { return JSON.parse(str); } 
  catch { return []; }
};

/**
 * Formatta i risultati includendo la logica dinamica per il ridesharing,
 * i rating e il ritaglio del percorso specifico per la richiesta utente.
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

  const veicoliMap = injectedVeicoliMap || getVeicoliMap();
  const recensioniCache = getRecensioniCache();

  return await Promise.all(
    allItems.slice(0, TOP_RESULTS).map(async (item) => {
      const v = veicoliMap.get(item.veicolo_id);
      const isCorsa = item.origine_lat !== undefined;
      const r = recensioniCache[v?.driver_id] || { media: 0, totale: 0 };

      // 1. CALCOLO SOTTO-PERCORSO (Il percorso specifico per il cliente)
      const percorsoVisualizzato = isCorsa && item.percorso_polyline 
        ? getSottoPercorso(item.percorso_polyline, richiesta.coord, richiesta.coordDest)
        : null;

      // 2. RECUPERO LOCALITÀ (Basato sulla richiesta specifica del cliente)
      const localitaOrigine = await getLocalitaSafe(richiesta.coord);
      const localitaDestinazione = await getLocalitaSafe(richiesta.coordDest);

      const oraPartenza = isCorsa
        ? (item.start_datetime ? new Date(item.start_datetime) : null)
        : (richiesta.start_datetime ? new Date(richiesta.start_datetime) : null);

      let durataMs = (isCorsa && item.durata) 
        ? item.durata.split(':').map(Number).reduce((acc, val, i) => acc + (val * [3600, 60, 1][i]), 0) * 1000 
        : durataRichiesta;

      const oraArrivo = oraPartenza ? new Date(oraPartenza.getTime() + durataMs) : null;
      const distanzaKm = isCorsa ? Number(item.distanza ?? 0) : distanzaRichiesta;
      const postiOccupatiReali = Number(item.picco_occupazione ?? 0);
      const postiTotali = Number(v?.posti_totali ?? 0);

      const prezzo = await calcolaPrezzo(
        { km: distanzaKm, tipo_corsa: item.tipo_corsa, posti_occupati: postiOccupatiReali, posti_totali: postiTotali, veicolo_id: item.veicolo_id },
        richiesta.posti_richiesti,
        item.stato
      );

      return {
        tipo: isCorsa ? 'corsa' : 'slot',
        id: uuidv4(),
        veicolo_id: item.veicolo_id,
        modello: v?.modello ?? 'N/D',
        tipoVeicolo: v?.tipo ?? 'citycar',
        servizi: Array.isArray(v?.servizi) ? v.servizi : safeParseJSON(v?.servizi),
        
        // Dati localizzati sulla RICHIESTA
        coordOrigine: richiesta.coord,
        coordDestinazione: richiesta.coordDest,
        localitaOrigine,
        localitaDestinazione,
        percorsoVisualizzato, // <-- Nuova proprietà per il frontend
        
        oraPartenza,
        oraArrivo,
        distanzaKm,
        postiTotali,
        postiOccupati: postiOccupatiReali,
        postiDisponibili: Math.max(0, postiTotali - postiOccupatiReali),
        prezzo,
        stato: item.stato,
        rating: { media: Number(r.media.toFixed(1)), totale: r.totale }
      };
    })
  );
}

export { formatResultsAsSlots as formatResults };