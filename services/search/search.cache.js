import { pool } from '../../db/db.js';
import polyline from 'polyline';
import * as turf from '@turf/turf';
import ngeohash from 'ngeohash';
import { redisClient } from '../../redis.js'; 

export const CacheStore = {
  veicoliCache: new Map(),
  disponibilitaCache: new Map(),
  corseCache: new Map(),
  recensioniCache: new Map(),
  pendingCache: new Map(),
  prenotazioniCache: new Map() 
};

export const GeoIndex = new Map(); 
export const SlotIndex = new Map(); 
export const TOP_RESULTS = 10;
const GEOHASH_PRECISION = 4;

// --- LOGICA CALCOLO STATO ---
export function calcolaStatoDisponibilita(d) {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();

    const giorniEsclusiNum = Array.isArray(d.giorni_esclusi) ? d.giorni_esclusi.map(Number) : [];
    if (giorniEsclusiNum.includes(dayOfWeek) || giorniEsclusiNum.length >= 7) return false;

    if (Array.isArray(d.inattivita)) {
        for (const i of d.inattivita) {
            const start = new Date(i.start);
            const end = new Date(i.fine);
            if (now >= start && now <= end) return false;
        }
    }

    const startDate = new Date(d.start);
    const endDate = new Date(d.fine);
    const startMinutes = startDate.getHours() * 60 + startDate.getMinutes();
    const endMinutes = endDate.getHours() * 60 + endDate.getMinutes();

    if (currentMinutes < startMinutes || currentMinutes > endMinutes) return false;

    return true;
}

// --- GESTIONE DATI ---
export const upsertPrenotazione = async (p) => {
    if (!CacheStore.prenotazioniCache.has(p.corsa_id)) {
        CacheStore.prenotazioniCache.set(p.corsa_id, []);
    }
    CacheStore.prenotazioniCache.get(p.corsa_id).push(p);

    if (redisClient) {
        await redisClient.hSet(`corsa:prenotazioni:${p.corsa_id}`, p.id || Math.random().toString(), JSON.stringify(p));
    }
};

export const upsertCorsa = async (c) => {
  const oldData = CacheStore.corseCache.get(c.id);

  if (oldData?.path_geohashes) {
    oldData.path_geohashes.forEach(h => {
        const prefix = h.substring(0, GEOHASH_PRECISION);
        GeoIndex.get(prefix)?.delete(c.id);
    });
  }
  
  let geohashes = typeof c.path_geohashes === 'string' ? JSON.parse(c.path_geohashes || '[]') : (c.path_geohashes || []);
  let decodedCoords = oldData?.decodedCoords || [];
  let bbox = oldData?.bbox;
  let turfLine = oldData?.turfLine;
  
  // Decodifica polilinea ed estrazione coordinate iniziali
  if (c.percorso_polyline) {
    try {
      const raw = polyline.decode(c.percorso_polyline);
      decodedCoords = raw.map(p => [Number(p[1]), Number(p[0])]); 
      turfLine = turf.lineString(decodedCoords);
      const lats = raw.map(p => p[0]);
      const lons = raw.map(p => p[1]);
      bbox = { minLat: Math.min(...lats), maxLat: Math.max(...lats), minLon: Math.min(...lons), maxLon: Math.max(...lons) };
    } catch (e) { console.error(`Errore decodifica ${c.id}:`, e); }
  }

  // Estrazione coordinate reali per Redis (primo punto della polilinea)
  const lat = decodedCoords.length > 0 ? decodedCoords[0][1] : 0;
  const lon = decodedCoords.length > 0 ? decodedCoords[0][0] : 0;

  const newCorsa = {
    ...(oldData || {}), ...c, id: c.id, 
    localitaOrigine: c.origine_address, localitaDestinazione: c.destinazione_address,
    prezzo: Number(c.prezzo_fisso ?? oldData?.prezzo ?? 0), 
    oraPartenza: c.start_datetime, oraArrivo: c.arrivo_datetime,
    distanza: Number(c.distanza || oldData?.distanza || 0), 
    tipo_corsa: c.tipo_corsa || oldData?.tipo_corsa || 'standard',
    veicolo_id: Number(c.veicolo_id || oldData?.veicolo_id), 
    decodedCoords, bbox, turfLine, path_geohashes: geohashes,
    posti_totali: c.posti_totali, posti_prenotati: c.posti_prenotati,
    lat, lon
  };
  
  CacheStore.corseCache.set(c.id, newCorsa);

  // Inserimento in Redis con coordinate estratte dalla polilinea
  if (redisClient && lat !== 0 && lon !== 0) {
    await redisClient.geoAdd('corse_geo_index', {
        longitude: lon,
        latitude: lat,
        member: c.id.toString()
    });
  }
  
  geohashes.forEach(h => {
    const prefix = h.substring(0, GEOHASH_PRECISION);
    if (!GeoIndex.has(prefix)) GeoIndex.set(prefix, new Set());
    GeoIndex.get(prefix).add(c.id);
  });
};

export async function loadCachesUltra(force = false) {
  if (!force && CacheStore.corseCache.size > 0 && CacheStore.disponibilitaCache.size > 0) return;
  const client = await pool.connect();
  try {
    console.log("🔄 Sincronizzazione cache e Redis...");
    if (redisClient) await redisClient.del('corse_geo_index');

    const cRes = await client.query(`SELECT * FROM corse WHERE stato IN ('prenotabile', 'in_corso')`);
    console.log(`[LOAD] Lette ${cRes.rows.length} corse`);
    for (const c of cRes.rows) await upsertCorsa(c);

    const pRes = await client.query(`SELECT corsa_id, id, posti_richiesti, start_index_polyline, end_index_polyline FROM prenotazioni`);
    CacheStore.prenotazioniCache.clear();
    for (const p of pRes.rows) await upsertPrenotazione(p);
    
    // ... (aggiungi qui le funzioni per veicoli e disponibilita se necessario)
    console.log(`📦 [CACHE] Pronta. Corse: ${CacheStore.corseCache.size}`);
  } finally { client.release(); }
}