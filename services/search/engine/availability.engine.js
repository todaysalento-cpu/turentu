import * as turf from '@turf/turf';
import params from '../../../config/params.js';
import { redisClient } from '../../../redis.js'; 
import { getPrenotazioniByCorsa } from '../search.cache.js';

// Funzione di utilità per calcolare il carico di una tratta specifica
function calcolaOccupazioneMassima(richiestaStart, richiestaEnd, prenotazioni) {
    return prenotazioni.reduce((maxOccupazione, p) => {
        const item = typeof p === 'string' ? JSON.parse(p) : p;
        const sovrappone = (richiestaStart < item.end_index_polyline) && (richiestaEnd > item.start_index_polyline);
        return sovrappone ? maxOccupazione + Number(item.posti_richiesti) : maxOccupazione;
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

/**
 * Filtro Disponibilità aggiornato con Redis GeoSearch e Log di Debug
 */
export async function filterDisponibilita(richiesta, veicoliCache, disponibilitaCache, corseCache) {
  console.log(`🔍 [SEARCH] Inizio ricerca per: ${richiesta.coord.lat}, ${richiesta.coord.lon}`);
  const startTime = Date.now();

  const vMap = veicoliCache instanceof Map ? veicoliCache : new Map(Array.isArray(veicoliCache) ? veicoliCache.map(v => [v.id, v]) : []);
  const corseMap = corseCache instanceof Map ? corseCache : new Map(Array.isArray(corseCache) ? corseCache.map(c => [c.id, c]) : []);
  
  // 1. RICERCA CORSE (Ottimizzata con Redis GeoSearch)
  let candidateIds = [];
  if (redisClient) {
      // Inserito raggio ampio 5000km per testare se il problema è la distanza 0,0
      candidateIds = await redisClient.geoSearch(
          'corse_geo_index',
          { longitude: richiesta.coord.lon, latitude: richiesta.coord.lat },
          { radius: 5000, unit: 'km' } 
      );
  }
  
  console.log(`[DEBUG SEARCH] Candidati GeoSearch trovati: ${candidateIds.length} | Radius: 5000km`);

  const postiRichiesti = Number(richiesta.posti_richiesti || 1);
  const corse = [];
  
  for (const id of candidateIds) {
      const c = corseMap.get(Number(id));
      if (!c) {
          console.log(`[DEBUG SEARCH] Corsa ${id} non trovata in corseMap`);
          continue;
      }
      
      try {
        const sottoPercorso = getSottoPercorso(c, richiesta.coord, richiesta.coordDest);
        if (!sottoPercorso) {
            console.log(`[DEBUG SEARCH] Corsa ${c.id}: SottoPercorso non trovato (fuori rotta o linea non valida)`);
            continue;
        }

        // Recupero prenotazioni da Redis
        const prenotazioniRaw = redisClient ? await redisClient.hVals(`corsa:prenotazioni:${c.id}`) : [];
        const occupazioneSegmento = calcolaOccupazioneMassima(sottoPercorso.startIdx, sottoPercorso.endIdx, prenotazioniRaw);
        const postiLiberi = Number(c.posti_totali) - occupazioneSegmento;

        console.log(`[DEBUG SEARCH] Corsa ${c.id}: PostiLiberi ${postiLiberi} | Richiesti ${postiRichiesti}`);
        
        if (postiLiberi < postiRichiesti) continue;
        
        c.postiDisponibili = postiLiberi - postiRichiesti;
        c.percorsoVisualizzato = sottoPercorso.coords;
        corse.push(c);
      } catch (err) { 
        console.error(`[ERROR SEARCH] Errore analisi corsa ${c.id}:`, err);
      }
  }

  console.log(`✅ [SEARCH] Completata in ${Date.now() - startTime}ms | Risultati: ${corse.length} corse.`);
  return { slots: [], corse }; 
}