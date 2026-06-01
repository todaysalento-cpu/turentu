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

// --- CORE: CORSE ---
export const upsertCorsa = async (c) => {
    const veicoloId = Number(c.veicolo_id);
    const corsaId = Number(c.id);
    
    // FIX: Decodifica isolata e copia profonda per evitare riferimenti condivisi
    let decodedCoords = [];
    if (c.percorso_polyline) {
        try {
            const raw = polyline.decode(c.percorso_polyline);
            // Mappiamo in modo esplicito creando nuovi array per ogni punto (Deep Copy)
            decodedCoords = raw.map(p => [Number(p[1]), Number(p[0])]);
        } catch (e) { 
            console.error(`[ERROR] Decodifica fallita ${corsaId}:`, e); 
            decodedCoords = []; 
        }
    }

    const lat = decodedCoords.length > 0 ? decodedCoords[0][1] : 0;
    const lon = decodedCoords.length > 0 ? decodedCoords[0][0] : 0;
    
    // Salviamo nella cache clonando esplicitamente l'array dei percorsi
    CacheStore.corseCache.set(corsaId, { 
        ...c, 
        veicolo_id: veicoloId, 
        lat, 
        lon, 
        decodedCoords: decodedCoords.map(p => [...p]) 
    });
    
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

export const removeCorsa = async (corsaId) => {
    const id = Number(corsaId);
    CacheStore.corseCache.delete(id);
    CacheStore.prenotazioniCache.delete(id);
    
    if (redisClient) {
        try {
            const hashes = await redisClient.sMembers(`corsa:hashes:${id}`);
            const pipeline = redisClient.multi();
            pipeline.zRem('corse_geo_index', id.toString());
            pipeline.del(`corsa:prenotazioni:${id}`);
            hashes.forEach(h => pipeline.sRem(`corsa:in_area:${h}`, id.toString()));
            pipeline.del(`corsa:hashes:${id}`);
            await pipeline.exec();
        } catch (e) { console.error("Errore pulizia Redis:", e); }
    }
};

// --- SYNC ENGINE ---
export async function loadCachesUltra(force = false) {
    if (!force && CacheStore.corseCache.size > 0 && CacheStore.veicoliCache.size > 0) return;
    
    // Reset se forziamo il reload per evitare inquinamento dati
    if (force) {
        CacheStore.corseCache.clear();
        CacheStore.veicoliCache.clear();
    }
    
    const client = await pool.connect();
    try {
        // Caricamento Veicoli
        const vRes = await client.query("SELECT *, ST_Y(coord::geometry) as lat, ST_X(coord::geometry) as lon FROM veicolo");
        for (const v of vRes.rows) upsertVeicolo(v);

        // Caricamento Disponibilità
        const dRes = await client.query("SELECT * FROM disponibilita_veicolo");
        for (const d of dRes.rows) await upsertDisponibilita(d);

        // Caricamento Corse
        console.log("🔄 [SYNC] Sincronizzazione corse...");
        const cRes = await client.query("SELECT * FROM corse WHERE stato IN ('prenotabile', 'in_corso') AND start_datetime > NOW()");
        for (const c of cRes.rows) await upsertCorsa(c);
        
        console.log(`📦 [SYNC] Completata. Corse totali: ${CacheStore.corseCache.size}`);
    } catch (err) {
        console.error("❌ [SYNC] Errore critico:", err);
    } finally { 
        client.release(); 
    }
}