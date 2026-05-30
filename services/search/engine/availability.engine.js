import ngeohash from 'ngeohash';
import * as turf from '@turf/turf';
import params from '../../../config/params.js';
import { GeoIndex } from '../search.cache.js'; 

const GEOHASH_PRECISION = 4;

/**
 * Taglio sicuro del percorso. 
 * decodedCoords è ora in formato [lon, lat] nativo.
 */
export function getSottoPercorso(decodedCoords, salita, discesa) {
  try {
    if (!Array.isArray(decodedCoords) || decodedCoords.length < 2) return null;

    // RIMOZIONE INVERSIONE: usiamo decodedCoords così com'è
    const line = turf.lineString(decodedCoords);
    
    const snapSalita = turf.nearestPointOnLine(line, turf.point([salita.lon, salita.lat]));
    const snapDiscesa = turf.nearestPointOnLine(line, turf.point([discesa.lon, discesa.lat]));

    if (snapSalita.properties.index >= snapDiscesa.properties.index) return null;

    const slice = turf.lineSlice(snapSalita, snapDiscesa, line);
    
    if (!slice.geometry.coordinates || slice.geometry.coordinates.length < 2) return null;

    // RIMOZIONE INVERSIONE: restituiamo [lon, lat] nativo
    return slice.geometry.coordinates;
  } catch (e) {
    console.error("Errore nel taglio della polilinea:", e);
    return null;
  }
}

export function filterDisponibilita(richiesta, veicoliCache, disponibilitaCache, corseCache, puntiRaccoltaCache = []) {
  const postiRichiesti = Number(richiesta.posti_richiesti || 1);
  const defaultTol = Number(params?.tolleranzaKm ?? 10);
  const maxStops = Number(params?.MAX_STOP_PER_CORSA ?? 5);

  const corseMap = corseCache instanceof Map ? corseCache : new Map(Array.isArray(corseCache) ? corseCache.map(c => [c.id, c]) : []);

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
      if (!c || !Array.isArray(c.decodedCoords) || c.decodedCoords.length < 2) return false;
      
      const postiOccupati = Number(c.picco_occupazione || 0);
      if ((postiOccupati + postiRichiesti) > Number(c.posti_totali)) return false;

      try {
        // RIMOZIONE INVERSIONE: line usa decodedCoords direttamente
        const line = turf.lineString(c.decodedCoords);
        const salita = turf.point([richiesta.coord.lon, richiesta.coord.lat]);
        const discesa = turf.point([richiesta.coordDest.lon, richiesta.coordDest.lat]);
        
        // Tolleranza Dinamica: più precisa per le tratte brevi
        const distRichiesta = turf.distance(salita, discesa, { units: 'kilometers' });
        const tolDinamica = distRichiesta < 10 ? 3.0 : defaultTol;

        const distSalita = turf.pointToLineDistance(salita, line, { units: 'kilometers' });
        const distDiscesa = turf.pointToLineDistance(discesa, line, { units: 'kilometers' });
        
        if (distSalita > tolDinamica || distDiscesa > tolDinamica) return false;

        const sottoPercorso = getSottoPercorso(c.decodedCoords, richiesta.coord, richiesta.coordDest);
        if (!sottoPercorso) return false;
        
        c.percorsoVisualizzato = sottoPercorso;
        
        // ... (resto delle logiche di puntiRaccolta e calcolaNuoveFermate invariate)
        return true;
      } catch (err) { return false; }
    });

  return { slots: [], corse };
}