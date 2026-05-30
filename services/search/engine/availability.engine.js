import ngeohash from 'ngeohash';
import * as turf from '@turf/turf';
import params from '../../../config/params.js';
import { GeoIndex } from '../search.cache.js'; 

const GEOHASH_PRECISION = 4;

/**
 * Taglio sicuro del percorso. 
 * decodedCoords è in formato [lon, lat] nativo.
 */
export function getSottoPercorso(decodedCoords, salita, discesa) {
  try {
    if (!Array.isArray(decodedCoords) || decodedCoords.length < 2) return null;

    const line = turf.lineString(decodedCoords);
    
    const snapSalita = turf.nearestPointOnLine(line, turf.point([salita.lon, salita.lat]));
    const snapDiscesa = turf.nearestPointOnLine(line, turf.point([discesa.lon, discesa.lat]));

    if (snapSalita.properties.index >= snapDiscesa.properties.index) return null;

    const slice = turf.lineSlice(snapSalita, snapDiscesa, line);
    
    if (!slice.geometry.coordinates || slice.geometry.coordinates.length < 2) return null;

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

  // --- NORMALIZZAZIONE INPUT ---
  const vMap = veicoliCache instanceof Map 
      ? veicoliCache 
      : new Map(Array.isArray(veicoliCache) ? veicoliCache.map(v => [v.id, v]) : []);
      
  const corseMap = corseCache instanceof Map 
      ? corseCache 
      : new Map(Array.isArray(corseCache) ? corseCache.map(c => [c.id, c]) : []);

  // 1. Ricerca Corse tramite Geohash
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
        const line = turf.lineString(c.decodedCoords);
        const salita = turf.point([richiesta.coord.lon, richiesta.coord.lat]);
        const discesa = turf.point([richiesta.coordDest.lon, richiesta.coordDest.lat]);
        
        const distRichiesta = turf.distance(salita, discesa, { units: 'kilometers' });
        const tolDinamica = distRichiesta < 10 ? 3.0 : defaultTol;

        const distSalita = turf.pointToLineDistance(salita, line, { units: 'kilometers' });
        const distDiscesa = turf.pointToLineDistance(discesa, line, { units: 'kilometers' });
        
        if (distSalita > tolDinamica || distDiscesa > tolDinamica) return false;

        const sottoPercorso = getSottoPercorso(c.decodedCoords, richiesta.coord, richiesta.coordDest);
        if (!sottoPercorso) return false;
        
        c.percorsoVisualizzato = sottoPercorso;
        
        c.puntiRaccoltaDisponibili = puntiRaccoltaCache
            .filter(p => turf.distance(salita, turf.point([p.lon, p.lat]), { units: 'kilometers' }) < 1.5)
            .sort((a, b) => a.dist - b.dist)
            .slice(0, 3);

        const nuoveFermate = calcolaNuoveFermate(c, richiesta);
        if ((c.numero_prenotazioni_attive || 0) + nuoveFermate > maxStops) return false;

        return true;
      } catch (err) { return false; }
    });

  // 2. Calcolo Dinamico Slots (Disponibilità Aperte)
  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const giornoCorrente = now.getDay();

  const slots = Array.from(disponibilitaCache.values()).filter(s => {
    const v = vMap.get(s.veicolo_id);
    
    // --- PROTEZIONE GEOMETRICA ---
    // Verifica che il veicolo esista e abbia coordinate numeriche valide
    if (!v || typeof v.lon !== 'number' || typeof v.lat !== 'number') return false;

    // Distanza massima per uno slot (es. 15km)
    const dist = turf.distance(
        turf.point([richiesta.coord.lon, richiesta.coord.lat]),
        turf.point([v.lon, v.lat]), 
        { units: 'kilometers' }
    );
    if (dist > 15.0) return false;

    // Validazione oraria e giorni
    const startMinutes = new Date(s.start).getHours() * 60 + new Date(s.start).getMinutes();
    const endMinutes = new Date(s.fine).getHours() * 60 + new Date(s.fine).getMinutes();
    const isOrarioValido = currentMinutes >= startMinutes && currentMinutes <= endMinutes;
    const isGiornoValido = Array.isArray(s.giorni_esclusi) ? !s.giorni_esclusi.includes(giornoCorrente) : true;

    return isOrarioValido && isGiornoValido && s.disponibile === true;
  });

  return { slots, corse };
}

function calcolaNuoveFermate(corsa, richiesta) {
  let extra = 0;
  const fermateEsistenti = Array.isArray(corsa.fermate_pianificate) ? corsa.fermate_pianificate : [];  
  if (!fermateEsistenti.some(f => turf.distance(turf.point([f.lon, f.lat]), turf.point([richiesta.coord.lon, richiesta.coord.lat])) < 0.5)) extra++;
  if (!fermateEsistenti.some(f => turf.distance(turf.point([f.lon, f.lat]), turf.point([richiesta.coordDest.lon, richiesta.coordDest.lat])) < 0.5)) extra++;
  return extra;
}