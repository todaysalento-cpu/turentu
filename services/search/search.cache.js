import { pool } from '../../db/db.js';
import polyline from 'polyline';
import { redisClient } from '../../redis.js';

if (!global.__CACHESTORE__) {
    global.__CACHESTORE__ = {
        veicoliCache: new Map(),
        disponibilitaCache: new Map(),
        corseCache: new Map(),
        prenotazioniCache: new Map() 
    };
    console.log("🚀 [CACHE] Inizializzata istanza globale di CacheStore");
}

export const CacheStore = global.__CACHESTORE__;

// --- CORE SYNC ---
export async function loadCachesUltra(force = false) {
    if (!force && CacheStore.corseCache.size > 0) return;
    
    // 1. Pulisci tutto prima di ricaricare (evita zombie data)
    CacheStore.corseCache.clear();
    CacheStore.veicoliCache.clear();
    CacheStore.disponibilitaCache.clear();
    
    const client = await pool.connect();
    try {
        // Caricamento in parallelo per velocità
        const [vRes, dRes, cRes] = await Promise.all([
            client.query("SELECT *, ST_Y(coord::geometry) as lat, ST_X(coord::geometry) as lon FROM veicolo"),
            client.query("SELECT * FROM disponibilita_veicolo"),
            client.query("SELECT * FROM corse WHERE stato IN ('prenotabile', 'in_corso') AND start_datetime > NOW()")
        ]);

        vRes.rows.forEach(v => upsertVeicolo(v));
        dRes.rows.forEach(d => upsertDisponibilita(d));
        
        console.log(`🔄 [SYNC] Caricamento ${cRes.rows.length} corse...`);
        for (const c of cRes.rows) {
            await upsertCorsa(c, false); // false = non chiamare redis ogni volta se non serve
        }
        
        console.log(`📦 [SYNC] Completata.`);
    } finally { 
        client.release(); 
    }
}

// --- LOGICA CORSA UNIFICATA ---
export const upsertCorsa = async (c, updateRedis = true) => {
    const corsaId = Number(c.id);
    
    // Decodifica robusta
    let decodedCoords = [];
    if (c.percorso_polyline) {
        try {
            decodedCoords = polyline.decode(c.percorso_polyline).map(p => [Number(p[1]), Number(p[0])]);
        } catch (e) { console.error(`[ERROR] Polyline ${corsaId}:`, e); }
    }

    // Salva in Memoria
    CacheStore.corseCache.set(corsaId, { 
        ...c, 
        decodedCoords,
        lat: decodedCoords.length > 0 ? decodedCoords[0][1] : 0,
        lon: decodedCoords.length > 0 ? decodedCoords[0][0] : 0
    });
    
    // Sync Redis solo se richiesto (per performance durante il load iniziale)
    if (updateRedis && redisClient) {
        await aggiornaIndiciRedis(corsaId, decodedCoords);
    }
};

async function aggiornaIndiciRedis(corsaId, coords) {
    const pipeline = redisClient.multi();
    // Pulisci vecchi indici
    const oldHashes = await redisClient.sMembers(`corsa:hashes:${corsaId}`);
    oldHashes.forEach(h => pipeline.sRem(`corsa:in_area:${h}`, corsaId.toString()));
    
    // Crea nuovi indici geohash
    const newHashes = new Set(coords.map(p => ngeohash.encode(p[1], p[0], 5)));
    newHashes.forEach(h => pipeline.sAdd(`corsa:in_area:${h}`, corsaId.toString()));
    pipeline.set(`corsa:hashes:${corsaId}`, JSON.stringify(Array.from(newHashes)));
    
    await pipeline.exec();
}