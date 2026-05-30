import ngeohash from 'ngeohash';
import * as turf from '@turf/turf';
import params from '../../../config/params.js';
import { GeoIndex, SlotIndex, getPrenotazioniByCorsa } from '../search.cache.js';

const GEOHASH_PRECISION = 5; 

// Funzione di utilità per calcolare il carico di una tratta specifica
function calcolaOccupazioneMassima(richiestaStart, richiestaEnd, prenotazioni) {
    // Si sovrappongono se: (StartA < EndB) E (EndA > StartB)
    return prenotazioni.reduce((maxOccupazione, p) => {
        const sovrappone = (richiestaStart < p.end_index_polyline) && (richiestaEnd > p.start_index_polyline);
        return sovrappone ? maxOccupazione + p.posti_richiesti : maxOccupazione;
    }, 0);
}

export function getSottoPercorso(corsa, salita, discesa) {
  try {
    const line = corsa.turfLine || turf.lineString(corsa.decodedCoords);
    const snapSalita = turf.nearestPointOnLine(line, turf.point([salita.lon, salita.lat]));
    const snapDiscesa = turf.nearestPointOnLine(line, turf.point([discesa.lon, discesa.lat]));
    
    if (snapSalita.properties.index >= snapDiscesa.properties.index) return null;
    
    const slice = turf.lineSlice(snapSalita, snapDiscesa, line);
    return { 
        coords: slice.geometry.coordinates, 
        startIdx: snapSalita.properties.index, 
        endIdx: snapDiscesa.properties.index 
    };
  } catch (e) { return null; }
}

export function filterDisponibilita(richiesta, veicoliCache, disponibilitaCache, corseCache) {
  console.log(`🔍 [SEARCH] Inizio ricerca per: ${richiesta.coord.lat}, ${richiesta.coord.lon}`);
  const startTime = Date.now();

  const vMap = veicoliCache instanceof Map ? veicoliCache : new Map(Array.isArray(veicoliCache) ? veicoliCache.map(v => [v.id, v]) : []);
  const corseMap = corseCache instanceof Map ? corseCache : new Map(Array.isArray(corseCache) ? corseCache.map(c => [c.id, c]) : []);
  const dCache = disponibilitaCache instanceof Map ? disponibilitaCache : new Map(Array.isArray(disponibilitaCache) ? disponibilitaCache.map(d => [d.id, d]) : []);

  // 1. RICERCA CORSE
  let candidateIds = new Set();
  const hash = ngeohash.encode(richiesta.coord.lat, richiesta.coord.lon, GEOHASH_PRECISION);
  [hash, ...ngeohash.neighbors(hash)].forEach(h => {
      const set = GeoIndex.get(h);
      if (set) set.forEach(id => candidateIds.add(id));
  });

  if (candidateIds.size === 0) {
      const coarseHash = ngeohash.encode(richiesta.coord.lat, richiesta.coord.lon, 4);
      [coarseHash, ...ngeohash.neighbors(coarseHash)].forEach(h => {
          const set = GeoIndex.get(h);
          if (set) set.forEach(id => candidateIds.add(id));
      });
  }

  const postiRichiesti = Number(richiesta.posti_richiesti || 1);
  const tol = Number(params?.tolleranzaKm ?? 10);

  const corse = Array.from(candidateIds)
    .map(id => corseMap.get(id))
    .filter(c => {
      if (!c) return false;
      
      try {
        const sottoPercorso = getSottoPercorso(c, richiesta.coord, richiesta.coordDest);
        if (!sottoPercorso) return false;

        // --- LOGICA DISPONIBILITÀ DINAMICA ---
        const prenotazioniCorsa = getPrenotazioniByCorsa(c.id);
        const occupazioneSegmento = calcolaOccupazioneMassima(sottoPercorso.startIdx, sottoPercorso.endIdx, prenotazioniCorsa);
        const postiLiberi = Number(c.posti_totali) - occupazioneSegmento;

        if (postiLiberi < postiRichiesti) return false;
        
        c.postiDisponibili = postiLiberi - postiRichiesti;
        c.percorsoVisualizzato = sottoPercorso.coords;
        return true;
      } catch (err) { return false; }
    });

  // 2. RICERCA SLOT (Invariata)
  const slots = Array.from(SlotIndex.values()).flat()
    .map(id => dCache.get(id))
    .filter(s => s?.disponibile && vMap.has(s.veicolo_id));

  console.log(`✅ [SEARCH] Completata in ${Date.now() - startTime}ms | Risultati: ${corse.length} corse.`);
  return { slots, corse };
}