import ngeohash from 'ngeohash';
import * as turf from '@turf/turf';
import params from '../../../config/params.js';
import { GeoIndex, SlotIndex } from '../search.cache.js'; // Importa anche SlotIndex

const GEOHASH_PRECISION = 4;

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
  const postiRichiesti = Number(richiesta.posti_richiesti || 1);
  const maxStops = Number(params?.MAX_STOP_PER_CORSA ?? 5);
  const vMap = veicoliCache;
  const corseMap = corseCache;

  // 1. RICERCA CORSE (Indice Geohash)
  const hash = ngeohash.encode(richiesta.coord.lat, richiesta.coord.lon, GEOHASH_PRECISION);
  const candidateIds = new Set();
  [hash, ...ngeohash.neighbors(hash)].forEach(h => {
      const set = GeoIndex.get(h);
      if (set) set.forEach(id => candidateIds.add(id));
  });

  const salitaPoint = turf.point([richiesta.coord.lon, richiesta.coord.lat]);
  const discesaPoint = turf.point([richiesta.coordDest.lon, richiesta.coordDest.lat]);
  const distRichiesta = turf.distance(salitaPoint, discesaPoint, { units: 'kilometers' });
  const tol = distRichiesta < 10 ? 3.0 : Number(params?.tolleranzaKm ?? 10);

  const corse = Array.from(candidateIds).map(id => corseMap.get(id)).filter(c => {
      if (!c || (Number(c.picco_occupazione || 0) + postiRichiesti) > Number(c.posti_totali)) return false;
      try {
        const line = c.turfLine || turf.lineString(c.decodedCoords);
        if (turf.pointToLineDistance(salitaPoint, line) > tol || turf.pointToLineDistance(discesaPoint, line) > tol) return false;
        const sottoPercorso = getSottoPercorso(c, richiesta.coord, richiesta.coordDest);
        if (!sottoPercorso) return false;
        c.percorsoVisualizzato = sottoPercorso;
        return ((c.numero_prenotazioni_attive || 0) + calcolaNuoveFermate(c, richiesta)) <= maxStops;
      } catch (err) { return false; }
    });

  // 2. RICERCA SLOT (Indice Spaziale + Filtro Numerico)
  const targetDate = new Date(richiesta.start_datetime);
  const targetMin = targetDate.getHours() * 60 + targetDate.getMinutes();
  const targetDay = targetDate.getDay();

  // Recupera SOLO gli slot vicini usando SlotIndex
  const candidatiSlotIds = new Set();
  [hash, ...ngeohash.neighbors(hash)].forEach(h => {
      const set = SlotIndex.get(h);
      if (set) set.forEach(id => candidatiSlotIds.add(id));
  });

  const slots = Array.from(candidatiSlotIds).map(id => disponibilitaCache.get(id)).filter(s => {
    if (!s || s.disponibile !== true) return false;
    
    // Filtro temporale ultra-rapido (usando valori pre-calcolati)
    if (targetMin < s.startMin || targetMin > s.endMin) return false;
    
    const v = vMap.get(s.veicolo_id);
    if (!v) return false;

    // Distanza finale di precisione
    return turf.distance([richiesta.coord.lon, richiesta.coord.lat], [v.lon, v.lat], { units: 'kilometers' }) <= 15.0 &&
           (!Array.isArray(s.giorni_esclusi) || !s.giorni_esclusi.includes(targetDay)) &&
           (!Array.isArray(s.inattivita) || !s.inattivita.some(i => targetDate >= new Date(i.start) && targetDate <= new Date(i.fine)));
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