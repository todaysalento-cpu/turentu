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
const GEOHASH_PRECISION_TRATTA = 5;

// --- GESTIONE PRENOTAZIONI (Ripristinata) ---
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

export const upsertDisponibilita = async (d) => {
    CacheStore.disponibilitaCache.set(Number(d.id), {
        ...d,
        veicolo_id: Number(d.veicolo_id),
        is_slot: true 
    });
    console.log(`✅ [CACHE] Disponibilità ${d.id} normalizzata.`);
};

// --- CORE: CORSE ---
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
            const hashes = await redisClient.sMembers(`corsa:hashes:${corsaId}`);
            const pipeline = redisClient.multi();
            
            pipeline.zRem('corse_geo_index', corsaId.toString());
            pipeline.del(`corsa:prenotazioni:${corsaId}`);
            hashes.forEach(h => pipeline.sRem(`corsa:in_area:${h}`, corsaId.toString()));
            pipeline.del(`corsa:hashes:${corsaId}`);
            
            if (lat !== 0 && lon !== 0) {
                pipeline.geoAdd('corse_geo_index', { longitude: lon, latitude: lat, member: corsaId.toString() });
            }
            
            const hashSet = new Set();
            decodedCoords.forEach((coord) => {
                const hash = ngeohash.encode(coord[1], coord[0], GEOHASH_PRECISION_TRATTA);
                [hash, ...ngeohash.neighbors(hash)].forEach(h => hashSet.add(h));
            });

            hashSet.forEach(h => pipeline.sAdd(`corsa:in_area:${h}`, corsaId.toString()));
            pipeline.sAdd(`corsa:hashes:${corsaId}`, Array.from(hashSet));
            
            await pipeline.exec();
        } catch (redisErr) {
            console.error(`[ERROR] Redis fallito per corsa ${corsaId}:`, redisErr);
        }
    }
};

// --- SYNC ENGINE ---
export async function loadVeicoliCache() {
    const client = await pool.connect();
    try {
        const vRes = await client.query("SELECT * FROM veicolo");
        for (const v of vRes.rows) upsertVeicolo(v);
        console.log(`✅ [SYNC] Veicoli caricati: ${CacheStore.veicoliCache.size}`);
    } finally { client.release(); }
}

export async function loadDisponibilitaCache() {
    const client = await pool.connect();
    try {
        const res = await client.query("SELECT * FROM disponibilita_veicolo");
        for (const d of res.rows) await upsertDisponibilita(d);
        console.log(`✅ [SYNC] Slot disponibilità caricati: ${CacheStore.disponibilitaCache.size}`);
    } finally { client.release(); }
}

export async function loadCachesUltra(force = false) {
    if (!force && CacheStore.corseCache.size > 0 && CacheStore.veicoliCache.size > 0) return;
    
    await loadVeicoliCache();
    await loadDisponibilitaCache();
    
    const client = await pool.connect();
    try {
        console.log("🔄 [SYNC] Sincronizzazione corse...");
        const cRes = await client.query("SELECT * FROM corse WHERE stato IN ('prenotabile', 'in_corso') AND start_datetime > NOW()");
        for (const c of cRes.rows) await upsertCorsa(c);
        console.log(`📦 [SYNC] Completata. Corse totali: ${CacheStore.corseCache.size}`);
    } catch (err) {
        console.error("❌ [SYNC] Errore:", err);
    } finally { 
        client.release(); 
    }
}