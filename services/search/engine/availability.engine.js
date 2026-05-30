import ngeohash from 'ngeohash';
import * as turf from '@turf/turf';
import params from '../../../config/params.js';
import { GeoIndex, SlotIndex } from '../search.cache.js';

// Precisione base, ma ora gestiamo il fallback
const GEOHASH_PRECISION = 5; 

export function getSottoPercorso(corsa, salita, discesa) {
  try {
    const line = corsa.turfLine || turf.lineString(corsa.decodedCoords);
    const snapSalita = turf.nearestPointOnLine(line, turf.point([salita.lon, salita.lat]));
    const snapDiscesa = turf.nearestPointOnLine(line, turf.point([discesa.lon, discesa.lat]));
    
    if (snapSalita.properties.index >= snapDiscesa.properties.index) return null;
    
    const slice = turf.lineSlice(snapSalita, snapDiscesa, line);
    return slice.geometry.coordinates?.length >= 2 ? slice.geometry.coordinates : null;
  } catch (e) { return null; }
}

export function filterDisponibilita(richiesta, veicoliCache, disponibilitaCache, corseCache) {
  console.log(`🔍 [SEARCH] Inizio ricerca per: ${richiesta.coord.lat}, ${richiesta.coord.lon}`);
  const startTime = Date.now();

  const vMap = veicoliCache instanceof Map ? veicoliCache : new Map(Array.isArray(veicoliCache) ? veicoliCache.map(v => [v.id, v]) : []);
  const corseMap = corseCache instanceof Map ? corseCache : new Map(Array.isArray(corseCache) ? corseCache.map(c => [c.id, c]) : []);
  const dCache = disponibilitaCache instanceof Map ? disponibilitaCache : new Map(Array.isArray(disponibilitaCache) ? disponibilitaCache.map(d => [d.id, d]) : []);

  // --- LOGICA FALLBACK GEOHASH ---
  let hash = ngeohash.encode(richiesta.coord.lat, richiesta.coord.lon, GEOHASH_PRECISION);
  let searchHashes = [hash, ...ngeohash.neighbors(hash)];
  
  // 1. RICERCA CORSE
  const candidateIds = new Set();
  searchHashes.forEach(h => {
      const set = GeoIndex.get(h);
      if (set) set.forEach(id => candidateIds.add(id));
  });

  // Se a precisione 5 non troviamo nulla, proviamo a precisione 4 (Fallback)
  if (candidateIds.size === 0) {
      console.log(`⚠️ [SEARCH] Precisione ${GEOHASH_PRECISION} vuota, fallback a precisione 4...`);
      const coarseHash = ngeohash.encode(richiesta.coord.lat, richiesta.coord.lon, 4);
      [coarseHash, ...ngeohash.neighbors(coarseHash)].forEach(h => {
          const set = GeoIndex.get(h);
          if (set) set.forEach(id => candidateIds.add(id));
      });
  }

  console.log(`ℹ️ [SEARCH] Corse candidate totali identificate: ${candidateIds.size}`);

  // Setup variabili di filtro
  const postiRichiesti = Number(richiesta.posti_richiesti || 1);
  const maxStops = Number(params?.MAX_STOP_PER_CORSA ?? 5);
  const salitaPoint = turf.point([richiesta.coord.lon, richiesta.coord.lat]);
  const discesaPoint = turf.point([richiesta.coordDest.lon, richiesta.coordDest.lat]);
  const distRichiesta = turf.distance(salitaPoint, discesaPoint, { units: 'kilometers' });
  const tol = distRichiesta < 10 ? 3.0 : Number(params?.tolleranzaKm ?? 10);
  const bboxBuffer = tol / 110; 

  console.time('⏳ [TIMER] Filtro_Geometria');
  const corse = Array.from(candidateIds)
    .map(id => corseMap.get(id))
    .filter(c => {
      if (!c) return false;
      if ((Number(c.picco_occupazione || 0) + postiRichiesti) > Number(c.posti_totali)) return false;
      
      // BBox check
      if (c.bbox) {
        if (richiesta.coord.lat < c.bbox.minLat - bboxBuffer || richiesta.coord.lat > c.bbox.maxLat + bboxBuffer ||
            richiesta.coord.lon < c.bbox.minLon - bboxBuffer || richiesta.coord.lon > c.bbox.maxLon + bboxBuffer) return false;
      }

      try {
        const line = c.turfLine || turf.lineString(c.decodedCoords);
        if (turf.pointToLineDistance(salitaPoint, line) > tol || turf.pointToLineDistance(discesaPoint, line) > tol) return false;
        
        const sottoPercorso = getSottoPercorso(c, richiesta.coord, richiesta.coordDest);
        if (!sottoPercorso) return false;
        
        c.percorsoVisualizzato = sottoPercorso;
        return ((c.numero_prenotazioni_attive || 0) + calcolaNuoveFermate(c, richiesta)) <= maxStops;
      } catch (err) { return false; }
    });
  console.timeEnd('⏳ [TIMER] Filtro_Geometria');

  // 2. RICERCA SLOT
  const candidatiSlotIds = new Set();
  searchHashes.forEach(h => {
      const set = SlotIndex.get(h);
      if (set) set.forEach(id => candidatiSlotIds.add(id));
  });

  const slots = Array.from(candidatiSlotIds)
    .map(id => dCache.get(id))
    .filter(s => {
      if (!s || s.disponibile !== true) return false;
      const v = vMap.get(s.veicolo_id);
      if (!v) return false;
      return turf.distance([richiesta.coord.lon, richiesta.coord.lat], [v.lon, v.lat], { units: 'kilometers' }) <= 15.0;
    });

  console.log(`✅ [SEARCH] Completata in ${Date.now() - startTime}ms | Risultati: ${corse.length} corse, ${slots.length} slot.`);
  return { slots, corse };
}

function calcolaNuoveFermate(corsa, richiesta) {
  let extra = 0;
  const fermate = Array.isArray(corsa.fermate_pianificate) ? corsa.fermate_pianificate : [];  
  if (!fermate.some(f => turf.distance([f.lon, f.lat], [richiesta.coord.lon, richiesta.coord.lat]) < 0.5)) extra++;
  if (!fermate.some(f => turf.distance([f.lon, f.lat], [richiesta.coordDest.lon, richiesta.coordDest.lat]) < 0.5)) extra++;
  return extra;
}