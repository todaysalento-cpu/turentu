import ngeohash from 'ngeohash';
import * as turf from '@turf/turf';
import params from '../../../config/params.js';
import { GeoIndex } from '../search.cache.js';

const GEOHASH_PRECISION = 4;

export function getSottoPercorso(decodedCoords, salita, discesa) {
  try {
    if (!Array.isArray(decodedCoords) || decodedCoords.length < 2) return null;
    const line = turf.lineString(decodedCoords);
    const snapSalita = turf.nearestPointOnLine(line, turf.point([salita.lon, salita.lat]));
    const snapDiscesa = turf.nearestPointOnLine(line, turf.point([discesa.lon, discesa.lat]));
    if (snapSalita.properties.index >= snapDiscesa.properties.index) return null;
    const slice = turf.lineSlice(snapSalita, snapDiscesa, line);
    return slice.geometry.coordinates?.length >= 2 ? slice.geometry.coordinates : null;
  } catch (e) { return null; }
}

export function filterDisponibilita(richiesta, veicoliCache, disponibilitaCache, corseCache, puntiRaccoltaCache = []) {
  const postiRichiesti = Number(richiesta.posti_richiesti || 1);
  const defaultTol = Number(params?.tolleranzaKm ?? 10);
  const maxStops = Number(params?.MAX_STOP_PER_CORSA ?? 5);

  const vMap = veicoliCache instanceof Map ? veicoliCache : new Map(Array.isArray(veicoliCache) ? veicoliCache.map(v => [v.id, v]) : []);
  const corseMap = corseCache instanceof Map ? corseCache : new Map(Array.isArray(corseCache) ? corseCache.map(c => [c.id, c]) : []);

  // 1. Ricerca Corse (Geospaziale con GeoIndex)
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
      if (!c || !Array.isArray(c.decodedCoords)) return false;
      if ((Number(c.picco_occupazione || 0) + postiRichiesti) > Number(c.posti_totali)) return false;
      try {
        const line = turf.lineString(c.decodedCoords);
        const salita = turf.point([richiesta.coord.lon, richiesta.coord.lat]);
        const discesa = turf.point([richiesta.coordDest.lon, richiesta.coordDest.lat]);
        const distRichiesta = turf.distance(salita, discesa, { units: 'kilometers' });
        const tol = distRichiesta < 10 ? 3.0 : defaultTol;
        
        if (turf.pointToLineDistance(salita, line) > tol || turf.pointToLineDistance(discesa, line) > tol) return false;
        
        const sottoPercorso = getSottoPercorso(c.decodedCoords, richiesta.coord, richiesta.coordDest);
        if (!sottoPercorso) return false;
        
        c.percorsoVisualizzato = sottoPercorso;
        return ((c.numero_prenotazioni_attive || 0) + calcolaNuoveFermate(c, richiesta)) <= maxStops;
      } catch (err) { return false; }
    });

  // 2. Calcolo Dinamico Slots (Basato su cache arricchita)
  const targetDate = new Date(richiesta.start_datetime);
  const targetMin = targetDate.getHours() * 60 + targetDate.getMinutes();
  const targetDay = targetDate.getDay();

  const slots = Array.from(disponibilitaCache.values()).filter(s => {
    const v = vMap.get(s.veicolo_id);
    
    // Verifica integrità veicolo
    if (!v || typeof v.lon !== 'number' || (v.lat === 0 && v.lon === 0)) return false;

    const dist = turf.distance([richiesta.coord.lon, richiesta.coord.lat], [v.lon, v.lat], { units: 'kilometers' });
    const sStart = new Date(s.start);
    const sEnd = new Date(s.fine);
    const startMin = sStart.getHours() * 60 + sStart.getMinutes();
    const endMin = sEnd.getHours() * 60 + sEnd.getMinutes();
    
    // Filtro Disponibilità (ora il flag s.disponibile è sempre definito e affidabile)
    const isValid = dist <= 15.0 && 
                    targetMin >= startMin && targetMin <= endMin &&
                    (!Array.isArray(s.giorni_esclusi) || !s.giorni_esclusi.includes(targetDay)) &&
                    (!Array.isArray(s.inattivita) || !s.inattivita.some(i => targetDate >= new Date(i.start) && targetDate <= new Date(i.fine))) &&
                    (s.disponibile === true);

    if (!isValid) {
        console.log(`[DEBUG SLOT] Escluso V:${s.veicolo_id} | Dist:${dist.toFixed(1)}km | Disp:${s.disponibile}`);
    } else {
        console.log(`[DEBUG SLOT] ✅ V:${s.veicolo_id} VALIDO`);
    }

    return isValid;
  });

  return { slots, corse };
}

function calcolaNuoveFermate(corsa, richiesta) {
  let extra = 0;
  const fermate = Array.isArray(corsa.fermate_pianificate) ? corsa.fermate_pianificate : [];  
  if (!fermate.some(f => turf.distance([f.lon, f.lat], [richiesta.coord.lon, richiesta.coord.lat]) < 0.5)) extra++;
  if (!fermate.some(f => turf.distance([f.lon, f.lat], [richiesta.coordDest.lon, richiesta.coordDest.lat]) < 0.5)) extra++;
  return extra;
}