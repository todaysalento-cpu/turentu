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

    // 1. Rimuovi duplicati adiacenti (causa comune di errori di slice)
    const puliti = decodedCoords.filter((c, i) => 
      i === 0 || (c[0] !== decodedCoords[i-1][0] || c[1] !== decodedCoords[i-1][1])
    );

    const line = turf.lineString(puliti.map(c => [c[1], c[0]]));
    
    // 2. Snap sui punti più vicini
    const snapSalita = turf.nearestPointOnLine(line, turf.point([salita.lon, salita.lat]));
    const snapDiscesa = turf.nearestPointOnLine(line, turf.point([discesa.lon, discesa.lat]));

    // 3. Taglio della linea
    const slice = turf.lineSlice(snapSalita, snapDiscesa, line);
    
    // 4. Verifica validità risultato
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

  const hashOrigine = ngeohash.encode(richiesta.coord.lat, richiesta.coord.lon, GEOHASH_PRECISION);
  const hashDestinazione = ngeohash.encode(richiesta.coordDest.lat, richiesta.coordDest.lon, GEOHASH_PRECISION);

  const setOrigine = GeoIndex.get(hashOrigine) || new Set();
  const setDestinazione = GeoIndex.get(hashDestinazione) || new Set();

  let candidateIds = new Set([...setOrigine].filter(id => setDestinazione.has(id)));
  if (candidateIds.size === 0) candidateIds = setOrigine;

  const slots = disponibilitaCache
    .filter(dv => {
      const v = veicoliCache.find(veicolo => veicolo.id === dv.veicolo_id);
      if (!v || Number(v.posti_totali) < postiRichiesti) return false;
      const distanzaKm = richiesta.coord ? haversineDistance({ lat: v.lat, lon: v.lon }, richiesta.coord) : 0;
      return distanzaKm <= tolKm;
    })
    .sort((a, b) => a._distanzaKm - b._distanzaKm);

  const corse = Array.from(candidateIds)
    .map(id => corseMap.get(id))
    .filter(c => {
      // Validazione base
      if (!c || !Array.isArray(c.decodedCoords) || c.decodedCoords.length < 2) return false;
      
      const postiOccupati = Number(c.picco_occupazione || 0);
      if ((postiOccupati + postiRichiesti) > Number(c.posti_totali)) return false;

      try {
        const line = turf.lineString(c.decodedCoords.map(coord => [coord[1], coord[0]]));
        const salita = turf.point([richiesta.coord.lon, richiesta.coord.lat]);
        const discesa = turf.point([richiesta.coordDest.lon, richiesta.coordDest.lat]);
        
        // 1. Controllo Distanza Perpendicolare
        const distSalita = turf.pointToLineDistance(salita, line);
        const distDiscesa = turf.pointToLineDistance(discesa, line);
        if (distSalita > tolKm || distDiscesa > tolKm) return false;

        // 2. Controllo Direzione
        const snapSalita = turf.nearestPointOnLine(line, salita);
        const snapDiscesa = turf.nearestPointOnLine(line, discesa);
        const distInizioToSalita = turf.length(turf.lineSlice(turf.point(line.geometry.coordinates[0]), snapSalita, line), { units: 'kilometers' });
        const distInizioToDiscesa = turf.length(turf.lineSlice(turf.point(line.geometry.coordinates[0]), snapDiscesa, line), { units: 'kilometers' });
        
        if (distInizioToSalita >= distInizioToDiscesa) return false;

        // 3. Arricchimento (Solo se il taglio è valido)
        const sottoPercorso = getSottoPercorso(c.decodedCoords, richiesta.coord, richiesta.coordDest);
        if (!sottoPercorso) return false;
        
        c.percorsoVisualizzato = sottoPercorso;
        c.puntiRaccoltaDisponibili = puntiRaccoltaCache
            .filter(p => turf.distance(snapSalita, turf.point([p.lon, p.lat]), { units: 'kilometers' }) < 1.5)
            .sort((a, b) => a.dist - b.dist)
            .slice(0, 3);

      } catch (err) {
        return false;
      }

      // 4. Controllo Fermate
      const nuoveFermate = calcolaNuoveFermate(c, richiesta);
      if ((c.numero_prenotazioni_attive || 0) + nuoveFermate > maxStops) return false;

      return true;
    });

  return { slots, corse };
}

export function rankResults(corse, recensioniCache) {
  return corse.sort((a, b) => {
    const rA = recensioniCache[a.conducente_id] || { media: 3.0, totale: 0 };
    const rB = recensioniCache[b.conducente_id] || { media: 3.0, totale: 0 };
    const bonusA = rA.totale > 20 ? 0.2 : 0;
    const bonusB = rB.totale > 20 ? 0.2 : 0;
    return (rB.media + bonusB) - (rA.media + bonusA);
  });
}

function calcolaNuoveFermate(corsa, richiesta) {
  let extra = 0;
  const fermateEsistenti = Array.isArray(corsa.fermate_pianificate) ? corsa.fermate_pianificate : [];  
  if (!fermateEsistenti.some(f => turf.distance(turf.point([f.lon, f.lat]), turf.point([richiesta.coord.lon, richiesta.coord.lat])) < 0.5)) extra++;
  if (!fermateEsistenti.some(f => turf.distance(turf.point([f.lon, f.lat]), turf.point([richiesta.coordDest.lon, richiesta.coordDest.lat])) < 0.5)) extra++;
  return extra;
}