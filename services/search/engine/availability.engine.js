import ngeohash from 'ngeohash';
import * as turf from '@turf/turf';
import params from '../../../config/params.js';
import { GeoIndex } from '../search.cache.js'; 

const GEOHASH_PRECISION = 4;

/**
 * Taglio sicuro del percorso con pulizia dei dati
 * Nota: decodedCoords è ora già in formato [lon, lat]
 */
export function getSottoPercorso(decodedCoords, salita, discesa) {
  try {
    if (!Array.isArray(decodedCoords) || decodedCoords.length < 2) return null;

    const line = turf.lineString(decodedCoords);
    
    // Snap sui punti più vicini (formato GeoJSON: [lon, lat])
    const snapSalita = turf.nearestPointOnLine(line, turf.point([salita.lon, salita.lat]));
    const snapDiscesa = turf.nearestPointOnLine(line, turf.point([discesa.lon, discesa.lat]));

    // Logica direzionale
    if (snapSalita.properties.index > snapDiscesa.properties.index) return null;

    const slice = turf.lineSlice(snapSalita, snapDiscesa, line);
    
    if (!slice.geometry.coordinates || slice.geometry.coordinates.length < 2) return null;

    return slice.geometry.coordinates; // Restituisce [lon, lat]
  } catch (e) {
    console.error("Errore nel taglio della polilinea:", e);
    return null;
  }
}

/**
 * Motore di ricerca ottimizzato
 */
export function filterDisponibilita(richiesta, veicoliCache, disponibilitaCache, corseCache, puntiRaccoltaCache = []) {
  const postiRichiesti = Number(richiesta.posti_richiesti || 1);
  const defaultTol = Number(params?.tolleranzaKm ?? 10);
  const maxStops = Number(params?.MAX_STOP_PER_CORSA ?? 5);

  const corseMap = corseCache instanceof Map ? corseCache : new Map(Array.isArray(corseCache) ? corseCache.map(c => [c.id, c]) : []);

  // 1. Espansione Geohash
  const hash = ngeohash.encode(richiesta.coord.lat, richiesta.coord.lon, GEOHASH_PRECISION);
  const candidateIds = new Set();
  [hash, ...ngeohash.neighbors(hash)].forEach(h => {
      const set = GeoIndex.get(h);
      if (set) set.forEach(id => candidateIds.add(id));
  });

  if (candidateIds.size === 0) corseMap.forEach((_, id) => candidateIds.add(id));

  const corse = Array.from(candidateIds)
    .map(id => corseMap.get(id))
    .filter(c => {
      // Validazione base
      if (!c || !Array.isArray(c.decodedCoords) || c.decodedCoords.length < 2) return false;
      
      const postiOccupati = Number(c.picco_occupazione || 0);
      if ((postiOccupati + postiRichiesti) > Number(c.posti_totali)) return false;

      try {
        // Linea già in formato [lon, lat] grazie al nuovo CacheStore
        const line = turf.lineString(c.decodedCoords);
        const salita = turf.point([richiesta.coord.lon, richiesta.coord.lat]);
        const discesa = turf.point([richiesta.coordDest.lon, richiesta.coordDest.lat]);
        
        // 2. Tolleranza Adattiva
        const distRichiesta = turf.distance(salita, discesa, { units: 'kilometers' });
        const tolDinamica = distRichiesta < 5 ? 2.5 : defaultTol; 

        const distSalita = turf.pointToLineDistance(salita, line, { units: 'kilometers' });
        const distDiscesa = turf.pointToLineDistance(discesa, line, { units: 'kilometers' });
        
        if (distSalita > tolDinamica || distDiscesa > tolDinamica) return false;

        // 3. Arricchimento
        const sottoPercorso = getSottoPercorso(c.decodedCoords, richiesta.coord, richiesta.coordDest);
        if (!sottoPercorso) return false;
        
        c.percorsoVisualizzato = sottoPercorso;
        
        // 4. Punti di raccolta
        const tolPunti = distRichiesta < 5 ? 1.0 : 1.5;
        c.puntiRaccoltaDisponibili = puntiRaccoltaCache
            .filter(p => turf.distance(salita, turf.point([p.lon, p.lat]), { units: 'kilometers' }) < tolPunti)
            .sort((a, b) => a.dist - b.dist)
            .slice(0, 3);

      } catch (err) {
        return false;
      }

      // 5. Controllo Fermate
      if ((c.numero_prenotazioni_attive || 0) + calcolaNuoveFermate(c, richiesta) > maxStops) return false;

      return true;
    });

  return { slots: [], corse };
}

export function rankResults(corse, recensioniCache) {
  return corse.sort((a, b) => {
    const rA = recensioniCache[a.conducente_id] || { media: 3.0, totale: 0 };
    const rB = recensioniCache[b.conducente_id] || { media: 3.0, totale: 0 };
    return (rB.media + (rB.totale > 20 ? 0.2 : 0)) - (rA.media + (rA.totale > 20 ? 0.2 : 0));
  });
}

function calcolaNuoveFermate(corsa, richiesta) {
  let extra = 0;
  const fermateEsistenti = Array.isArray(corsa.fermate_pianificate) ? corsa.fermate_pianificate : [];  
  if (!fermateEsistenti.some(f => turf.distance(turf.point([f.lon, f.lat]), turf.point([richiesta.coord.lon, richiesta.coord.lat])) < 0.5)) extra++;
  if (!fermateEsistenti.some(f => turf.distance(turf.point([f.lon, f.lat]), turf.point([richiesta.coordDest.lon, richiesta.coordDest.lat])) < 0.5)) extra++;
  return extra;
}