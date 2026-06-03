import { pool } from '../../db/db.js';
import ngeohash from 'ngeohash';
import { redisClient } from '../../redis.js';

const SYNC_TTL_MS = 60000; // 1 minuto

export const CacheStore = {
    veicoliCache: new Map(),
    disponibilitaCache: new Map(),
    corseCache: new Map(),
    prenotazioniCache: new Map(),
    lastSync: 0
};

// --- GESTIONE DISPONIBILITÀ ---
export const upsertDisponibilita = (d) => {
    const normalized = {
        ...d,
        veicolo_id: Number(d.veicolo_id),
        driver_id: Number(d.driver_id), 
        is_slot: true,
        inattivita: typeof d.inattivita === 'string' ? JSON.parse(d.inattivita) : (d.inattivita || [])
    };
    CacheStore.disponibilitaCache.set(Number(d.id), normalized);
};

export const removeDisponibilita = async (disponibilitaId) => {
    const id = Number(disponibilitaId);
    const d = CacheStore.disponibilitaCache.get(id);
    
    if (d && d.lat && d.lon) {
        const hash = ngeohash.encode(Number(d.lat), Number(d.lon), 5);
        await redisClient.sRem(`slot:in_area:${hash}`, id.toString());
    }
    
    CacheStore.disponibilitaCache.delete(id);
    console.log(`🗑️ [CACHE] Disponibilità ${id} rimossa.`);
};

// --- GESTIONE PRENOTAZIONI ---
export const upsertPrenotazione = async (prenotazione) => {
    console.log(`📝 [CACHE] Aggiornamento prenotazione: ${prenotazione.id}`);
    CacheStore.prenotazioniCache.set(Number(prenotazione.id), prenotazione);
};

// --- GESTIONE VEICOLI ---
export const upsertVeicolo = (v) => {
    CacheStore.veicoliCache.set(Number(v.id), v);
};

export const removeVeicolo = async (veicoloId) => {
    CacheStore.veicoliCache.delete(Number(veicoloId));
    console.log(`🗑️ [CACHE] Veicolo ${veicoloId} rimosso.`);
};

// --- GESTIONE CORSE ---
export const upsertCorsa = async (c, indicizzare = false) => {
    CacheStore.corseCache.set(Number(c.id), c);
    if (indicizzare && c.decodedCoords) {
        await aggiornaIndiciRedis(c.id, c.decodedCoords);
    }
};

export const removeCorsa = async (corsaId) => {
    const id = Number(corsaId);
    CacheStore.corseCache.delete(id);
    
    const hashes = await redisClient.get(`corsa:hashes:${id}`);
    if (hashes) {
        const hashList = JSON.parse(hashes);
        const pipeline = redisClient.multi();
        hashList.forEach(h => pipeline.sRem(`corsa:in_area:${h}`, id.toString()));
        pipeline.del(`corsa:hashes:${id}`);
        await pipeline.exec();
    }
    console.log(`🗑️ [CACHE] Corsa ${id} rimossa.`);
};

// --- SYNC ENGINE ---
export async function loadCachesUltra(force = false) {
    if (!force && (Date.now() - CacheStore.lastSync < SYNC_TTL_MS)) return;
    
    const client = await pool.connect();
    try {
        const [vRes, dRes, cRes] = await Promise.all([
            client.query("SELECT id, ST_Y(coord::geometry) as lat, ST_X(coord::geometry) as lon, posti_totali FROM veicolo"),
            client.query(`SELECT dv.*, v.driver_id, ST_Y(v.coord::geometry) as lat, ST_X(v.coord::geometry) as lon 
                          FROM disponibilita_veicolo dv 
                          JOIN veicolo v ON dv.veicolo_id = v.id`),
            client.query("SELECT *, ST_AsText(percorso) as wkt FROM corse WHERE stato IN ('prenotabile', 'in_corso', 'da_attivare') AND start_datetime > NOW() - INTERVAL '1 hour'")
        ]);
        
        vRes.rows.forEach(v => upsertVeicolo(v));
        
        dRes.rows.forEach(d => {
            upsertDisponibilita(d);
            aggiornaIndiciDisponibilita(d); 
        });
        
        await Promise.all(cRes.rows.map(c => upsertCorsa(c, true)));

        CacheStore.lastSync = Date.now();
        console.log(`📦 [SYNC] Completata con successo.`);
    } catch (err) {
        console.error("❌ [SYNC] Errore critico:", err);
    } finally {
        client.release();
    }
}

// --- UTILS REDIS ---
async function aggiornaIndiciRedis(corsaId, coords) {
    if (!redisClient || !coords || coords.length === 0) return;
    const newHashes = [...new Set(coords.map(p => ngeohash.encode(p[1], p[0], 5)))];
    const pipeline = redisClient.multi();
    newHashes.forEach(h => pipeline.sAdd(`corsa:in_area:${h}`, corsaId.toString()));
    pipeline.set(`corsa:hashes:${corsaId}`, JSON.stringify(newHashes));
    await pipeline.exec();
}

async function aggiornaIndiciDisponibilita(d) {
    if (!redisClient || !d.lat || !d.lon) return;
    const hash = ngeohash.encode(Number(d.lat), Number(d.lon), 5);
    await redisClient.sAdd(`slot:in_area:${hash}`, d.id.toString());
}