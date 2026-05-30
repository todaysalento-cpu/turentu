import ngeohash from 'ngeohash';
import * as turf from '@turf/turf';
import params from '../../../config/params.js';
import { GeoIndex } from '../search.cache.js';

// Aumentata a 5 per ridurre i candidati inviati al filtro
const GEOHASH_PRECISION = 5; 
const BBOX_PADDING = 0.2;

/**
 * Assumiamo che corsa.turfLine sia già pre-calcolato nella cache come turf.lineString
 */
export function getSottoPercorso(corsa, salita, discesa) {
  try {
    const line = corsa.turfLine;
    const snapSalita = turf.nearestPointOnLine(line, turf.point([salita.lon, salita.lat]));
    const snapDiscesa = turf.nearestPointOnLine(line, turf.point([discesa.lon, discesa.lat]));
    
    if (snapSalita.properties.index >= snapDiscesa.properties.index) return null;
    
    const slice = turf.lineSlice(snapSalita, snapDiscesa, line);
    return slice.geometry.coordinates?.length >= 2 ? slice.geometry.coordinates : null;
  } catch (e) { return null; }
}

export function filterDisponibilita(richiesta, veicoliCache, disponibilitaCache, corseCache) {
  const postiRichiesti = Number(richiesta.posti_richiesti || 1);
  const defaultTol = Number(params?.tolleranzaKm ?? 10);
  const maxStops = Number(params?.MAX_STOP_PER_CORSA ?? 5);

  const vMap = veicoliCache instanceof Map ? veicoliCache : new Map(Array.isArray(veicoliCache) ? veicoliCache.map(v => [v.id, v]) : []);
  const corseMap = corseCache instanceof Map ? corseCache : new Map(Array.isArray(corseCache) ? corseCache.map(c => [c.id, c]) : []);

  // 1. Ricerca Corse con GeoIndex (Precisione 5)
  const hash = ngeohash.encode(richiesta.coord.lat, richiesta.coord.lon, GEOHASH_PRECISION);
  const candidateIds = new Set();
  [hash, ...ngeohash.neighbors(hash)].forEach(h => {
      const set = GeoIndex.get(h);
      if (set) set.forEach(id => candidateIds.add(id));
  });

  const corse = Array.from(candidateIds)
    .map(id => corseMap.get(id))
    .filter(c => {
      // Filtro rapido: Integrità, capacità e BBOX pre-calcolata
      if (!c?.turfLine) return false;
      if ((Number(c.picco_occupazione || 0) + postiRichiesti) > Number(c.posti_totali)) return false;
      
      if (c.bbox && (
          richiesta.coord.lat < (c.bbox.minLat - BBOX_PADDING) || richiesta.coord.lat > (c.bbox.maxLat + BBOX_PADDING) ||
          richiesta.coord.lon < (c.bbox.minLon - BBOX_PADDING) || richiesta.coord.lon > (c.bbox.maxLon + BBOX_PADDING))) {
        return false;
      }

      // Distanza (Usa turfLine già in memoria)
      const salitaPoint = turf.point([richiesta.coord.lon, richiesta.coord.lat]);
      const distRichiesta = turf.distance(salitaPoint, turf.point([richiesta.coordDest.lon, richiesta.coordDest.lat]), { units: 'kilometers' });
      const tol = distRichiesta < 10 ? 3.0 : defaultTol;
      
      if (turf.pointToLineDistance(salitaPoint, c.turfLine) > tol) return false;
      
      const sottoPercorso = getSottoPercorso(c, richiesta.coord, richiesta.coordDest);
      if (!sottoPercorso) return false;
      
      c.percorsoVisualizzato = sottoPercorso;
      return ((c.numero_prenotazioni_attive || 0) + calcolaNuoveFermate(c, richiesta)) <= maxStops;
    });

  // 2. Slots (Ottimizzato)
  const targetDate = new Date(richiesta.start_datetime);
  const targetMin = targetDate.getHours() * 60 + targetDate.getMinutes();
  const targetDay = targetDate.getDay();

  const slots = Array.from(disponibilitaCache.values()).filter(s => {
    const v = vMap.get(s.veicolo_id);
    if (!v) return false;

    // Distanza rapida
    const dist = turf.distance([richiesta.coord.lon, richiesta.coord.lat], [v.lon, v.lat], { units: 'kilometers' });
    if (dist > 15.0) return false;
    
    // Verifica tempo
    const sStart = new Date(s.start);
    const sEnd = new Date(s.fine);
    const startMin = sStart.getHours() * 60 + sStart.getMinutes();
    const endMin = sEnd.getHours() * 60 + sEnd.getMinutes();
    
    return targetMin >= startMin && targetMin <= endMin &&
           (!Array.isArray(s.giorni_esclusi) || !s.giorni_esclusi.includes(targetDay)) &&
           (s.disponibile === true);
  });

  return { slots, corse };
}

function calcolaNuoveFermate(corsa, richiesta) {
  let extra = 0;
  const fermate = corsa.fermate_pianificate || [];  
  if (!fermate.some(f => turf.distance([f.lon, f.lat], [richiesta.coord.lon, richiesta.coord.lat]) < 0.5)) extra++;
  if (!fermate.some(f => turf.distance([f.lon, f.lat], [richiesta.coordDest.lon, richiesta.coordDest.lat]) < 0.5)) extra++;
  return extra;
}