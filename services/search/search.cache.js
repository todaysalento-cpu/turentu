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
    prenotazioniCache: new Map() 
};

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

export const upsertDisponibilita = (d) => {
    d.disponibile = calcolaStatoDisponibilita(d);
    CacheStore.disponibilitaCache.set(Number(d.id), d);
};

// --- CORE: CORSE (Ottimizzato e Safe) ---
export const upsertCorsa = async (c) => {
    const corsaId = Number(c.id);
    const oldData = CacheStore.corseCache.get(corsaId);
    let decodedCoords = oldData?.decodedCoords || [];
    
    if (c.percorso_polyline) {
        try {
            const raw = polyline.decode(c.percorso_polyline);
            decodedCoords = raw.map(p => [Number(p[1]), Number(p[0])]); 
        } catch (e) { console.error(`Errore decodifica polyline ${c.id}:`, e); }
    }

    const lat = decodedCoords.length > 0 ? decodedCoords[0][1] : 0;
    const lon = decodedCoords.length > 0 ? decodedCoords[0][0] : 0;
    
    CacheStore.corseCache.set(corsaId, { ...oldData, ...c, lat, lon, decodedCoords });

    if (redisClient) {
        // Pulizia atomica prima dell'inserimento
        await removeCorsa(corsaId, true);

        const pipeline = redisClient.multi();
        
        // 1. Indice GEO nativo Redis
        if (lat !== 0 && lon !== 0) {
            pipeline.geoAdd('corse_geo_index', { longitude: lon, latitude: lat, member: corsaId.toString() });
        }
        
        // 2. Indice inverso (Geohash neighbors)
        const hashSet = new Set();
        decodedCoords.forEach((coord) => {
            const hash = ngeohash.encode(coord[1], coord[0], GEOHASH_PRECISION_TRATTA);
            [hash, ...ngeohash.neighbors(hash)].forEach(h => hashSet.add(h));
        });

        hashSet.forEach(h => pipeline.sAdd(`corsa_in_area:${h}`, corsaId.toString()));
        pipeline.sAdd(`corsa:hashes:${corsaId}`, Array.from(hashSet));
        
        await pipeline.exec();
    }
};

export const removeCorsa = async (corsaId, internal = false) => {
    const id = Number(corsaId);
    CacheStore.corseCache.delete(id);
    CacheStore.prenotazioniCache.delete(id);
    
    if (redisClient) {
        const hashes = await redisClient.sMembers(`corsa:hashes:${id}`);
        const pipeline = redisClient.multi();
        
        pipeline.zRem('corse_geo_index', id.toString());
        pipeline.del(`corsa:prenotazioni:${id}`);
        hashes.forEach(h => pipeline.sRem(`corsa_in_area:${h}`, id.toString()));
        pipeline.del(`corsa:hashes:${id}`);

        await pipeline.exec();
    }
};

// --- SYNC ENGINE ---
export async function loadCachesUltra(force = false) {
    if (!force && CacheStore.corseCache.size > 0) return;
    
    const client = await pool.connect();
    try {
        console.log("🔄 Sincronizzazione cache in corso...");
        const cRes = await client.query("SELECT * FROM corse WHERE stato IN ('prenotabile', 'in_corso')");
        
        // Pulizia totale indici Redis se necessario (opzionale: solo se force è true)
        if (force) await redisClient.flushdb(); 
        
        await Promise.all(cRes.rows.map(c => upsertCorsa(c)));
        console.log(`📦 [CACHE] Pronta. Corse caricate: ${CacheStore.corseCache.size}`);
    } catch (err) {
        console.error("❌ Errore sincronizzazione:", err);
    } finally { client.release(); }
}