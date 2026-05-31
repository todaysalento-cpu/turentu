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
    console.log(`[DEBUG] Elaborazione corsa ID: ${corsaId}`);
    
    const oldData = CacheStore.corseCache.get(corsaId);
    let decodedCoords = oldData?.decodedCoords || [];
    
    if (c.percorso_polyline) {
        try {
            const raw = polyline.decode(c.percorso_polyline);
            decodedCoords = raw.map(p => [Number(p[1]), Number(p[0])]); 
            console.log(`[DEBUG] Corsa ${corsaId}: Polyline decodificata (${decodedCoords.length} punti)`);
        } catch (e) { 
            console.error(`[ERROR] Decodifica polyline fallita per corsa ${c.id}:`, e); 
        }
    } else {
        console.warn(`[WARN] Corsa ${corsaId} senza percorso_polyline`);
    }

    const lat = decodedCoords.length > 0 ? decodedCoords[0][1] : 0;
    const lon = decodedCoords.length > 0 ? decodedCoords[0][0] : 0;
    
    CacheStore.corseCache.set(corsaId, { ...oldData, ...c, lat, lon, decodedCoords });

    if (redisClient) {
        try {
            await removeCorsa(corsaId, true);
            const pipeline = redisClient.multi();
            
            if (lat !== 0 && lon !== 0) {
                pipeline.geoAdd('corse_geo_index', { longitude: lon, latitude: lat, member: corsaId.toString() });
            }
            
            const hashSet = new Set();
            decodedCoords.forEach((coord) => {
                const hash = ngeohash.encode(coord[1], coord[0], GEOHASH_PRECISION_TRATTA);
                [hash, ...ngeohash.neighbors(hash)].forEach(h => hashSet.add(h));
            });

            hashSet.forEach(h => pipeline.sAdd(`corsa_in_area:${h}`, corsaId.toString()));
            pipeline.sAdd(`corsa:hashes:${corsaId}`, Array.from(hashSet));
            
            await pipeline.exec();
            console.log(`[DEBUG] Corsa ${corsaId} salvata in Redis con ${hashSet.size} hashes.`);
        } catch (redisErr) {
            console.error(`[ERROR] Fallimento scrittura Redis per corsa ${corsaId}:`, redisErr);
        }
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
        console.log("🔄 [SYNC] Inizio sincronizzazione cache...");
        
        // Filtriamo per corse future o in corso per essere precisi
        const cRes = await client.query("SELECT * FROM corse WHERE stato IN ('prenotabile', 'in_corso') AND start_datetime > NOW()");
        console.log(`[SYNC] Trovate ${cRes.rowCount} corse attive nel database.`);
        
        if (force) await redisClient.flushdb(); 
        
        for (const c of cRes.rows) {
            await upsertCorsa(c);
        }
        
        console.log(`📦 [SYNC] Completata. Corse in memoria: ${CacheStore.corseCache.size}`);
    } catch (err) {
        console.error("❌ [SYNC] Errore critico:", err);
    } finally { 
        client.release(); 
        console.log("[SYNC] Connessione DB rilasciata.");
    }
}