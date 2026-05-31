import * as turf from '@turf/turf';
import params from '../../../config/params.js';
import { redisClient } from '../../../redis.js'; 
import { getPrenotazioniByCorsa } from '../search.cache.js';

function calcolaOccupazioneMassima(richiestaStart, richiestaEnd, prenotazioni) {
    return prenotazioni.reduce((maxOccupazione, p) => {
        const item = typeof p === 'string' ? JSON.parse(p) : p;
        // Verifica sovrapposizione tra segmenti di indice
        const sovrappone = (richiestaStart < item.end_index_polyline) && (richiestaEnd > item.start_index_polyline);
        return sovrappone ? maxOccupazione + Number(item.posti_richiesti) : maxOccupazione;
    }, 0);
}

export function getSottoPercorso(corsa, salita, discesa) {
  try {
    const line = corsa.turfLine || turf.lineString(corsa.decodedCoords);
    const snapSalita = turf.nearestPointOnLine(line, turf.point([salita.lon, salita.lat]));
    const snapDiscesa = turf.nearestPointOnLine(line, turf.point([discesa.lon, discesa.lat]));
    
    // Debug: Verifica indici trovati
    if (snapSalita.properties.index >= snapDiscesa.properties.index) {
        console.log(`[DEBUG] Corsa ${corsa.id}: Salita index ${snapSalita.properties.index} >= Discesa index ${snapDiscesa.properties.index}`);
        return null;
    }
    
    const slice = turf.lineSlice(snapSalita, snapDiscesa, line);
    return { 
        coords: slice.geometry.coordinates, 
        startIdx: snapSalita.properties.index, 
        endIdx: snapDiscesa.properties.index 
    };
  } catch (e) { 
      console.log(`[DEBUG] Errore getSottoPercorso corsa ${corsa.id}:`, e.message);
      return null; 
  }
}

export async function filterDisponibilita(richiesta, veicoliCache, disponibilitaCache, corseCache) {
  const startTime = Date.now();
  const corseMap = corseCache instanceof Map ? corseCache : new Map(Array.isArray(corseCache) ? corseCache.map(c => [c.id, c]) : []);
  
  let candidateIds = [];
  if (redisClient) {
      candidateIds = await redisClient.geoSearch(
          'corse_geo_index',
          { longitude: richiesta.coord.lon, latitude: richiesta.coord.lat },
          { radius: 100, unit: 'km' } 
      );
  }
  
  console.log(`[DEBUG] CandidateIds trovate via GeoSearch: ${candidateIds.length}`);

  const postiRichiesti = Number(richiesta.posti_richiesti || 1);
  const corse = [];
  
  for (const id of candidateIds) {
      const c = corseMap.get(Number(id));
      if (!c) {
          console.log(`[DEBUG] Corsa ${id} non trovata nella cache.`);
          continue;
      }
      
      try {
        const sottoPercorso = getSottoPercorso(c, richiesta.coord, richiesta.coordDest);
        if (!sottoPercorso) {
            console.log(`[DEBUG] Corsa ${c.id}: Sotto-percorso non valido (tratta inversa o non trovata).`);
            continue;
        }

        const prenotazioniRaw = redisClient ? await redisClient.hVals(`corsa:prenotazioni:${c.id}`) : [];
        const occupazioneSegmento = calcolaOccupazioneMassima(sottoPercorso.startIdx, sottoPercorso.endIdx, prenotazioniRaw);
        const postiLiberi = Number(c.posti_totali) - occupazioneSegmento;

        if (postiLiberi < postiRichiesti) {
            console.log(`[DEBUG] Corsa ${c.id}: Posti insufficienti. Liberi: ${postiLiberi}, Richiesti: ${postiRichiesti}`);
            continue;
        }
        
        c.postiDisponibili = postiLiberi - postiRichiesti;
        c.percorsoVisualizzato = sottoPercorso.coords;
        corse.push(c);
      } catch (err) { 
        console.error(`[ERROR SEARCH] Errore analisi corsa ${c.id}:`, err);
      }
  }

  console.log(`✅ [SEARCH] Completata in ${Date.now() - startTime}ms | Risultati filtrati: ${corse.length}`);
  return { slots: [], corse }; 
}