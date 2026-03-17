// engine/route.engine.js
import { haversineDistance } from '../../utils/geo.util.js';
import { stimaDurata } from '../../utils/maps.util.js';

// Cache semplice in memoria per evitare chiamate ripetute a Maps
const routeCache = new Map();

export async function getRouteData(coordOrigine, coordDestinazione) {
  const key = `${coordOrigine.lat},${coordOrigine.lon}-${coordDestinazione.lat},${coordDestinazione.lon}`;
  if (routeCache.has(key)) {
    console.log('🧠 Maps cache HIT');
    return routeCache.get(key);
  }

  console.log('🌍 Maps API CALL');
  const durataMs = await stimaDurata(coordOrigine, coordDestinazione);
  const kmTotali = haversineDistance(coordOrigine, coordDestinazione);

  const result = { durataMs, kmTotali };
  routeCache.set(key, result);
  return result;
}
