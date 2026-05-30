import ngeohash from 'ngeohash';
import * as turf from '@turf/turf';
import { haversineDistance } from '../../../utils/geo.util.js';
import params from '../../../config/params.js';
import { GeoIndex } from '../search.cache.js'; 

const GEOHASH_PRECISION = 4;

/**
 * Taglio sicuro del percorso con pulizia dei dati
 */
export function getSottoPercorso(decodedCoords, salita, discesa) {
  try {
    if (!Array.isArray(decodedCoords) || decodedCoords.length < 2) return null;

    const line = turf.lineString(decodedCoords.map(c => [c[1], c[0]]));
    
    // Snap sui punti più vicini con indice di posizione
    const snapSalita = turf.nearestPointOnLine(line, turf.point([salita.lon, salita.lat]));
    const snapDiscesa = turf.nearestPointOnLine(line, turf.point([discesa.lon, discesa.lat]));

    // Logica direzionale pura: il punto di salita deve apparire PRIMA di quello di discesa
    if (snapSalita.properties.index >= snapDiscesa.properties.index) return null;

    // Taglio della linea
    const slice = turf.lineSlice(snapSalita, snapDiscesa, line);
    
    if (!slice.geometry.coordinates || slice.geometry.coordinates.length < 2) return null;

    return slice.geometry.coordinates.map(c => [c[1], c[0]]);
  } catch (e) {
    console.error("Errore nel taglio della polilinea:", e);
    return null;
  }
}

/**
 * Motore di ricerca con filtraggio geografico, direzionale e di capienza
 */
export function filterDisponibilita(richiesta, veicoliCache, disponibilitaCache, corseCache, puntiRaccoltaCache = []) {
  const postiRichiesti = Number(richiesta.posti_richiesti || 1);
  const tolKm = Number(params?.tolleranzaKm ?? 10);
  const maxStops = Number(params?.MAX_STOP_PER_CORSA ?? 5);

  const corseMap = corseCache instanceof Map 
      ? corseCache 
      : new Map(Array.isArray(corseCache) ? corseCache.map(c => [c.id, c]) : []);

  // 1. Espansione Geohash (punto centrale + 8 vicini) per non perdere corse "al bordo"
  const hash = ngeohash.encode(richiesta.coord.lat, richiesta.coord.lon, GEOHASH_PRECISION);
  const candidateIds = new Set();
  [hash, ...ngeohash.neighbors(hash)].forEach(h => {
      const set = GeoIndex.get(h);
      if (set) set.forEach(id => candidateIds.add(id));
  });

  // Se non troviamo nulla nei vicini, estendiamo a tutto il set (opzionale, per robustezza)
  if (candidateIds.size === 0) {
      corseMap.forEach((_, id) => candidateIds.add(id));
  }

  const corse = Array.from(candidateIds)
    .map(id => corseMap.get(id))
    .filter(c => {
      if (!c || !Array.isArray(c.decodedCoords) || c.decodedCoords.length < 2) return false;
      
      const postiOccupati = Number(c.picco_occupazione || 0);
      if ((postiOccupati + postiRichiesti) > Number(c.posti_totali)) return false;

      try {
        const line = turf.lineString(c.decodedCoords.map(coord => [coord[1], coord[0]]));
        const salita = turf.point([richiesta.coord.lon, richiesta.coord.lat]);
        const discesa = turf.point([richiesta.coordDest.lon, richiesta.coordDest.lat]);
        
        // Controllo Prossimità al percorso (Buffer di tolleranza)
        const distSalita = turf.pointToLineDistance(salita, line, { units: 'kilometers' });
        const distDiscesa = turf.pointToLineDistance(discesa, line, { units: 'kilometers' });
        
        if (distSalita > tolKm || distDiscesa > tolKm) return false;

        // Arricchimento (esegue anche il check direzionale tramite indice)
        const sottoPercorso = getSottoPercorso(c.decodedCoords, richiesta.coord, richiesta.coordDest);
        if (!sottoPercorso) return false;
        
        c.percorsoVisualizzato = sottoPercorso;
        
        // Punti di raccolta (ottimizzati)
        c.puntiRaccoltaDisponibili = puntiRaccoltaCache
            .filter(p => turf.distance(salita, turf.point([p.lon, p.lat]), { units: 'kilometers' }) < 1.5)
            .sort((a, b) => a.dist - b.dist)
            .slice(0, 3);

      } catch (err) {
        return false;
      }

      // Controllo Fermate
      const nuoveFermate = calcolaNuoveFermate(c, richiesta);
      if ((c.numero_prenotazioni_attive || 0) + nuoveFermate > maxStops) return false;

      return true;
    });

  return { slots: [], corse };
}

// Funzioni accessorie invariate
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