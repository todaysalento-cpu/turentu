import { pool } from '../../db/db.js';
import polyline from 'polyline';
import * as turf from '@turf/turf';
import ngeohash from 'ngeohash';
import { redisClient } from '../../redis.js'; 

/**
 * Singleton Pattern: Gestione stato globale cache
 */
if (!global.__CACHESTORE__) {
    global.__CACHESTORE__ = {
        veicoliCache: new Map(),
        disponibilitaCache: new Map(),
        corseCache: new Map(),
        recensioniCache: new Map(),
        prenotazioniCache: new Map() 
    };
    console.log("🚀 [CACHE] Inizializzata istanza globale di CacheStore");
}

export const CacheStore = global.__CACHESTORE__;

// Precisione 5: ~4.9km x 4.9km (bilanciamento ottimale tra precisione e performance)
const GEOHASH_PRECISION_TRATTA = 5;
// Campionamento: un punto ogni 50km garantisce copertura costante per tratte lunghe
const DISTANZA_CAMPIONAMENTO_KM = 50;

// --- GESTIONE PRENOTAZIONI ---
export const upsertPrenotazione = async (prenotazione) => {
    const corsaId = Number(prenotazione.corsa_id);
    const pId = Number(prenotazione.id);
    
    if (!CacheStore.prenotazioniCache.has(corsaId)) {
        CacheStore.prenotazioniCache.set(corsaId, new Map());
    }
    CacheStore.prenotazioniCache.get(corsaId).set(pId, prenotazione);

    if (redisClient) {
        await redisClient.hSet(`corsa:prenotazioni:${corsaId}`, pId.toString(), JSON.stringify(prenotazione));
    }
};

export const removePrenotazione = async (corsaId, prenotazioneId) => {
    const cId = Number(corsaId);
    const pId = Number(prenotazioneId);
    if (CacheStore.prenotazioniCache.has(cId)) CacheStore.prenotazioniCache.get(cId).delete(pId);
    if (redisClient) await redisClient.hDel(`corsa:prenotazioni:${cId}`, pId.toString());
};

// --- GESTIONE DATI VEICOLI E DISPONIBILITÀ ---
export const upsertVeicolo = (v) => {
    const normalized = { ...v, lat: Number(v.lat || 0), lon: Number(v.lon || 0) };
    CacheStore.veicoliCache.set(Number(v.id), { ...(CacheStore.veicoliCache.get(Number(v.id)) || {}), ...normalized });
};

export const removeVeicolo = (id) => CacheStore.veicoliCache.delete(Number(id));

export const upsertDisponibilita = async (d) => {
    const normalized = {
        ...d,
        veicolo_id: Number(d.veicolo_id),
        is_slot: true,
        inattivita: typeof d.inattivita === 'string' ? JSON.parse(d.inattivita) : (d.inattivita || [])
    };
    CacheStore.disponibilitaCache.set(Number(d.id), normalized);
};

export const removeDisponibilita = (id) => CacheStore.disponibilitaCache.delete(Number(id));

// --- CORE: CORSE OTTIMIZZATO ---
export const upsertCorsa = async (c) => {
    const veicoloId = Number(c.veicolo_id);
    const corsaId = Number(c.id);
    
    let decodedCoords = [];
    if (c.percorso_polyline) {
        try {
            const raw = polyline.decode(c.percorso_polyline);
            decodedCoords = raw.map(p => [Number(p[1]), Number(p[0])]);
        } catch (e) { console.error(`[ERROR] Decodifica fallita ${corsaId}:`, e); }
    }

    const lat = decodedCoords.length > 0 ? decodedCoords[0][1] : 0;
    const lon = decodedCoords.length > 0 ? decodedCoords[0][0] : 0;
    
    CacheStore.corseCache.set(corsaId, { ...c, veicolo_id: veicoloId, lat, lon, decodedCoords });
    
    if (redisClient) {
        try {
            // 1. Pulizia atomica dei vecchi indici basata sugli hash esistenti
            const oldHashes = await redisClient.sMembers(`corsa:hashes:${corsaId}`);
            const pipeline = redisClient.multi();
            
            pipeline.zRem('corse_geo_index', corsaId.toString());
            pipeline.del(`corsa:prenotazioni:${corsaId}`);
            oldHashes.forEach(h => pipeline.sRem(`corsa:in_area:${h}`, corsaId.toString()));
            pipeline.del(`corsa:hashes:${corsaId}`);
            
            // 2. Re-indicizzazione mirata (Campionamento Dinamico)
            if (lat !== 0 && lon !== 0) {
                pipeline.geoAdd('corse_geo_index', { longitude: lon, latitude: lat, member: corsaId.toString() });
            }
            
            const hashSet = new Set();
            if (decodedCoords.length >= 2) {
                const line = turf.lineString(decodedCoords);
                const lunghezzaTotale = turf.length(line, { units: 'kilometers' });
                // Calcolo dinamico punti: minimo 3, uno ogni 50km per tratte lunghe
                const numeroPunti = Math.max(3, Math.ceil(lunghezzaTotale / DISTANZA_CAMPIONAMENTO_KM));
                
                for (let i = 0; i < numeroPunti; i++) {
                    const frazione = i / (numeroPunti - 1);
                    const point = turf.along(line, frazione * lunghezzaTotale, { units: 'kilometers' });
                    const [lonP, latP] = point.geometry.coordinates;
                    
                    const hash = ngeohash.encode(latP, lonP, GEOHASH_PRECISION_TRATTA);
                    // Aggiungiamo il Geohash e i suoi 8 vicini per garantire la continuità spaziale
                    [hash, ...ngeohash.neighbors(hash)].forEach(h => hashSet.add(h));
                }
            }

            hashSet.forEach(h => pipeline.sAdd(`corsa:in_area:${h}`, corsaId.toString()));
            pipeline.sAdd(`corsa:hashes:${corsaId}`, Array.from(hashSet));
            
            await pipeline.exec();
        } catch (redisErr) {
            console.error(`[ERROR] Redis fallito per corsa ${corsaId}:`, redisErr);
        }
    }
};

export const removeCorsa = async (corsaId) => {
    const id = Number(corsaId);
    CacheStore.corseCache.delete(id);
    CacheStore.prenotazioniCache.delete(id);
    if (redisClient) {
        const hashes = await redisClient.sMembers(`corsa:hashes:${id}`);
        const pipeline = redisClient.multi();
        pipeline.zRem('corse_geo_index', id.toString());
        pipeline.del(`corsa:prenotazioni:${id}`);
        hashes.forEach(h => pipeline.sRem(`corsa:in_area:${h}`, id.toString()));
        pipeline.del(`corsa:hashes:${id}`);
        await pipeline.exec();
    }
};

// --- SYNC ENGINE ---
export async function loadVeicoliCache() {
    const client = await pool.connect();
    try {
        const query = `SELECT *, ST_Y(coord::geometry) as lat, ST_X(coord::geometry) as lon FROM veicolo`;
        const vRes = await client.query(query);
        for (const v of vRes.rows) upsertVeicolo(v);
    } finally { client.release(); }
}

export async function loadDisponibilitaCache() {
    const client = await pool.connect();
    try {
        const res = await client.query("SELECT * FROM disponibilita_veicolo");
        for (const d of res.rows) await upsertDisponibilita(d);
    } finally { client.release(); }
}

export async function loadCachesUltra(force = false) {
    if (!force && CacheStore.corseCache.size > 0 && CacheStore.veicoliCache.size > 0) return;
    await loadVeicoliCache();
    await loadDisponibilitaCache();
    const client = await pool.connect();
    try {
        const cRes = await client.query("SELECT * FROM corse WHERE stato IN ('prenotabile', 'in_corso') AND start_datetime > NOW()");
        for (const c of cRes.rows) await upsertCorsa(c);
        console.log(`📦 [SYNC] Completata. Corse totali: ${CacheStore.corseCache.size}`);
    } catch (err) { console.error("❌ [SYNC] Errore:", err); } finally { client.release(); }
}