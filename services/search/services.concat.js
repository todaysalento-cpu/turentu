// --- engine\availability.engine.js ---
// engine/availability.engine.js
import ngeohash from 'ngeohash';
import { haversineDistance } from '../../utils/geo.util.js';
import params from '../../config/params.js';

export function filterDisponibilita(richiesta, veicoliCache, disponibilitaCache, corseCache) {
  const richiestaStart = new Date(richiesta.arrivo_datetime);
  const day = richiestaStart.getDay();

  const richiestaHash = richiesta.coord
    ? ngeohash.encode(richiesta.coord.lat, richiesta.coord.lon, 5)
    : null;

  const hashVicini = richiestaHash
    ? [...ngeohash.neighbors(richiestaHash), richiestaHash]
    : [];

  const slots = disponibilitaCache
    .filter(dv => {
      const v = veicoliCache[dv.veicolo_id];
      if (!v) return false;
      if (v.posti_totali < richiesta.posti_richiesti) return false;
      if (dv.giorni_esclusi?.includes(day)) return false;

      const occupato = corseCache.some(c =>
        c.veicolo_id === dv.veicolo_id &&
        richiestaStart >= new Date(c.start_datetime) &&
        richiestaStart <= new Date(c.arrivo_datetime)
      );
      if (occupato) return false;

      const distanzaKm = richiesta.coord
        ? haversineDistance({ lat: v.lat, lon: v.lon }, richiesta.coord)
        : 0;

      if (richiestaHash && !hashVicini.includes(v.geohash) && distanzaKm > params.tolleranzaKm)
        return false;

      dv._distanzaKm = distanzaKm;
      return true;
    })
    .sort((a, b) => a._distanzaKm - b._distanzaKm);

  const corse = corseCache.filter(c => {
    if (richiesta.posti_richiesti > c.posti_disponibili) return false;

    if (richiesta.coordDest) {
      const d = haversineDistance(
        { lat: c.dest_lat, lon: c.dest_lon },
        richiesta.coordDest
      );
      if (d > params.tolleranzaKm) return false;
    }

    return true;
  });

  return { slots, corse };
}


// --- engine\route.engine.js ---
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


// --- formatter\search.formatter.js ---
// formatter/search.formatter.js
import { v4 as uuidv4 } from 'uuid';
import { getRouteData } from '../engine/route.engine.js';
import { calcolaPrezzoSlot } from '../pricing/pricing.engine.js';

export async function formatResults(richiesta, slots, corse, veicoliCache) {
  const { durataMs, kmTotali } = await getRouteData(richiesta.coord, richiesta.coordDest);

  const slotResults = await Promise.all(slots.map(async slot => {
    const v = veicoliCache[slot.veicolo_id];
    const oraPartenza = new Date(richiesta.arrivo_datetime);
    const oraArrivo = new Date(oraPartenza.getTime() + durataMs);
    const prezzo = await calcolaPrezzoSlot({ km: kmTotali, tipo_corsa: 'libero' }, v.euro_km, richiesta.posti_richiesti);

    return {
      tipo: 'slot',
      id: uuidv4(),
      veicolo_id: v.id,
      modello: v.modello,
      servizi: v.servizi,
      coordOrigine: richiesta.coord,
      coordDestinazione: richiesta.coordDest,
      oraPartenza,
      oraArrivo,
      durataMs,
      distanzaKm: kmTotali,
      postiTotali: v.posti_totali,
      postiRichiesti: richiesta.posti_richiesti,
      prezzo,
      euro_km: Number(v.euro_km),
      stato: 'libero',
      corseCompatibili: []
    };
  }));

  const corsaResults = await Promise.all(corse.map(async corsa => {
    const v = veicoliCache[corsa.veicolo_id];
    const oraPartenza = new Date(corsa.start_datetime);
    const durataMsCorsa = corsa.durata ? corsa.durata * 1000 : 0;
    const oraArrivo = new Date(oraPartenza.getTime() + durataMsCorsa);
    const prezzo = await calcolaPrezzoSlot({ km: Number(corsa.distanza ?? 0), tipo_corsa: corsa.tipo_corsa }, v.euro_km, richiesta.posti_richiesti);

    return {
      tipo: 'corsa',
      id: uuidv4(),
      veicolo_id: corsa.veicolo_id,
      modello: v?.modello,
      servizi: v?.servizi,
      coordOrigine: { lat: corsa.origine_lat, lon: corsa.origine_lon },
      coordDestinazione: { lat: corsa.dest_lat, lon: corsa.dest_lon },
      oraPartenza,
      oraArrivo,
      durataMs: durataMsCorsa,
      prezzo,
      stato: corsa.stato,
      corseCompatibili: [corsa]
    };
  }));

  return [...slotResults, ...corsaResults];
}



// --- pricing\pricing.engine.js ---
// pricing/pricing.engine.js
import { calcolaPrezzo } from '../../utils/pricing.util.js';

export async function calcolaPrezzoSlot({ km, tipo_corsa }, euro_km, posti_richiesti) {
  return calcolaPrezzo(
    { km, tipo_corsa, posti_prenotati: 0, primo_posto: 0 },
    euro_km ?? 1,
    1,
    posti_richiesti,
    tipo_corsa
  );
}


// --- search.service.js ---
// search.service.js
import { loadCachesUltra } from './search.cache.js';
import { filterDisponibilita } from './engine/availability.engine.js';
import { formatResults } from './formatter/search.formatter.js';

let veicoliCache, disponibilitaCache, corseCache;

export async function cercaSlotUltra(richiesta) {
  await loadCachesUltra();
  // Aggiorna le cache locali
  veicoliCache = global.veicoliCache;
  disponibilitaCache = global.disponibilitaCache;
  corseCache = global.corseCache;

  const { slots, corse } = filterDisponibilita(richiesta, veicoliCache, disponibilitaCache, corseCache);
  return formatResults(richiesta, slots, corse, veicoliCache);
}


