import { pool } from '../../db/db.js';
import polyline from 'polyline';
import * as turf from '@turf/turf';
import ngeohash from 'ngeohash';
import { redisClient } from '../../redis.js'; 

/**
 * Singleton Pattern: Garantisce che CacheStore sia lo stesso oggetto 
 * in tutta l'applicazione Node.js, evitando duplicazioni di memoria.
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

// --- LOGICA CALCOLO STATO ---
export function calcolaStatoDisponibilita(d) {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();

    const giorniEsclusiNum = Array.isArray(d.giorni_esclusi) ? d.giorni_esclusi.map(Number) : [];
    if (giorniEsclusiNum.includes(dayOfWeek) || giorniEsclusiNum.length >= 7) return false;

    if (Array.isArray(d.inattivita)) {
        for (const i of d.inattivita) {
            if (now >= new Date(i.start) && now <= new Date(i.fine)) return false;
        }
    }

    const startMinutes = new Date(d.start).getHours() * 60 + new Date(d.start).getMinutes();
    const endMinutes = new Date(d.fine).getHours() * 60 + new Date(d.fine).getMinutes();

    return (startMinutes > endMinutes) 
        ? (currentMinutes >= startMinutes || currentMinutes <= endMinutes)
        : (currentMinutes >= startMinutes && currentMinutes <= endMinutes);
}

// --- GESTIONE DATI VEICOLI E DISPONIBILITÀ ---
export const upsertVeicolo = (v) => {
    const normalized = { ...v, lat: Number(v.lat || 0), lon: Number(v.lon || 0) };
    CacheStore.veicoliCache.set(Number(v.id), { ...(CacheStore.veicoliCache.get(Number(v.id)) || {}), ...normalized });
};

export const removeVeicolo = (id) => CacheStore.veicoliCache.delete(Number(id));

export const upsertDisponibilita = async (d) => {
    d.disponibile = calcolaStatoDisponibilita(d);
    CacheStore.disponibilitaCache.set(Number(d.id), d);
    console.log(`✅ [CACHE] Disponibilità ${d.id} aggiornata.`);
};

export const removeDisponibilita = (id) => CacheStore.disponibilitaCache.delete(Number(id));

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
    
    if (CacheStore.prenotazioniCache.has(cId)) {
        CacheStore.prenotazioniCache.get(cId).delete(pId);
    }
    
    if (redisClient) {
        await redisClient.hDel(`corsa:prenotazioni:${cId}`, pId.toString());
    }
};

// --- CORE: CORSE ---
export const upsertCorsa = async (c) => {
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
    
    // Aggiornamento cache in RAM
    CacheStore.corseCache.set(corsaId, { ...c, lat, lon, decodedCoords });
    
    if (redisClient) {
        try {
            const hashes = await redisClient.sMembers(`corsa:hashes:${corsaId}`);
            const pipeline = redisClient.multi();
            
            pipeline.zRem('corse_geo_index', corsaId.toString());
            pipeline.del(`corsa:prenotazioni:${corsaId}`);
            // Pulizia usando la chiave corretta
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

            // Scrittura usando la chiave corretta
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
            // Pulizia coerente con la chiave di salvataggio
            hashes.forEach(h => pipeline.sRem(`corsa:in_area:${h}`, id.toString()));
            pipeline.del(`corsa:hashes:${id}`);
            await pipeline.exec();
        } catch (e) { console.error("Errore pulizia Redis:", e); }
    }
};

// --- SYNC ENGINE ---
export async function loadCachesUltra(force = false) {
    if (!force && CacheStore.corseCache.size > 0) return;
    
    const client = await pool.connect();
    try {
        console.log("🔄 [SYNC] Inizio sincronizzazione...");
        const cRes = await client.query("SELECT * FROM corse WHERE stato IN ('prenotabile', 'in_corso') AND start_datetime > NOW()");
        
        for (const c of cRes.rows) {
            await upsertCorsa(c);
        }
        
        console.log(`📦 [SYNC] Completata. Corse in memoria: ${CacheStore.corseCache.size}`);
    } catch (err) {
        console.error("❌ [SYNC] Errore:", err);
    } finally { 
        client.release(); 
    }
}