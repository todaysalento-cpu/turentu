import { pool } from '../../db/db.js';
import polyline from 'polyline';
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
        prenotazioniCache: new Map(),
        lastSync: 0
    };
    console.log("🚀 [CACHE] Inizializzata istanza globale di CacheStore");
}

export const CacheStore = global.__CACHESTORE__;
const SYNC_TTL_MS = 30000; 

// --- GESTIONE PRENOTAZIONI ---
export const upsertPrenotazione = async (prenotazione) => {
    const corsaId = Number(prenotazione.corsa_id);
    const pId = Number(prenotazione.id);
    if (!CacheStore.prenotazioniCache.has(corsaId)) CacheStore.prenotazioniCache.set(corsaId, new Map());
    CacheStore.prenotazioniCache.get(corsaId).set(pId, prenotazione);

    if (redisClient) {
        const key = `corsa:prenotazioni:${corsaId}`;
        try {
            await redisClient.hSet(key, pId.toString(), JSON.stringify(prenotazione));
        } catch (err) {
            console.error(`❌ [CACHE] Errore upsertPrenotazione:`, err);
        }
    }
};

// --- GESTIONE DATI VEICOLI E DISPONIBILITÀ ---
export const upsertVeicolo = (v) => {
    const normalized = { ...v, lat: Number(v.lat || 0), lon: Number(v.lon || 0) };
    CacheStore.veicoliCache.set(Number(v.id), { ...(CacheStore.veicoliCache.get(Number(v.id)) || {}), ...normalized });
};

export const upsertDisponibilita = (d) => {
    // IMPORTANTE: driver_id deve essere sempre presente qui
    const normalized = {
        ...d,
        veicolo_id: Number(d.veicolo_id),
        driver_id: Number(d.driver_id), 
        is_slot: true,
        inattivita: typeof d.inattivita === 'string' ? JSON.parse(d.inattivita) : (d.inattivita || [])
    };
    CacheStore.disponibilitaCache.set(Number(d.id), normalized);
};

// --- CORE: CORSE ---
export const upsertCorsa = async (c, updateRedis = true) => {
    const corsaId = Number(c.id);
    let decodedCoords = [];
    if (c.percorso_polyline) {
        try {
            decodedCoords = polyline.decode(c.percorso_polyline).map(p => [Number(p[1]), Number(p[0])]);
        } catch (e) { console.error(`[ERROR] Polyline ${corsaId}:`, e); }
    }

    CacheStore.corseCache.set(corsaId, { 
        ...c, 
        decodedCoords,
        lat: decodedCoords.length > 0 ? decodedCoords[0][1] : 0,
        lon: decodedCoords.length > 0 ? decodedCoords[0][0] : 0
    });
    
    if (updateRedis && redisClient) await aggiornaIndiciRedis(corsaId, decodedCoords);
};

// --- SYNC ENGINE (Riparato con JOIN) ---
export async function loadCachesUltra(force = false) {
    if (!force && (Date.now() - CacheStore.lastSync < SYNC_TTL_MS)) return;
    
    const client = await pool.connect();
    try {
        const [vRes, dRes, cRes] = await Promise.all([
            client.query("SELECT id, ST_Y(coord::geometry) as lat, ST_X(coord::geometry) as lon, posti_totali FROM veicolo"),
            // JOIN fondamentale per caricare il driver_id in cache
            client.query(`SELECT dv.*, v.driver_id 
                          FROM disponibilita_veicolo dv 
                          JOIN veicolo v ON dv.veicolo_id = v.id`),
            client.query("SELECT * FROM corse WHERE stato IN ('prenotabile', 'in_corso', 'da_attivare') AND start_datetime > NOW() - INTERVAL '1 hour'")
        ]);

        vRes.rows.forEach(v => upsertVeicolo(v));
        dRes.rows.forEach(d => upsertDisponibilita(d));
        await Promise.all(cRes.rows.map(c => upsertCorsa(c, true)));

        CacheStore.lastSync = Date.now();
        console.log(`📦 [SYNC] Completata. Corse: ${CacheStore.corseCache.size} | Disp: ${CacheStore.disponibilitaCache.size}`);
    } catch (err) {
        console.error("❌ [SYNC] Errore critico:", err);
    } finally {
        client.release();
    }
}

// --- UTILS REDIS ---
async function aggiornaIndiciRedis(corsaId, coords) {
    if (!redisClient || coords.length === 0) return;
    const newHashes = [...new Set(coords.map(p => ngeohash.encode(p[1], p[0], 5)))];
    const pipeline = redisClient.multi();
    newHashes.forEach(h => pipeline.sAdd(`corsa:in_area:${h}`, corsaId.toString()));
    pipeline.set(`corsa:hashes:${corsaId}`, JSON.stringify(newHashes));
    await pipeline.exec();
}