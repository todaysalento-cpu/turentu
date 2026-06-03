import { pool } from '../../db/db.js';
import polyline from 'polyline';
import ngeohash from 'ngeohash';
import { redisClient } from '../../redis.js';

// ... (CacheStore singleton rimane invariato)

// --- GESTIONE DATI VEICOLI E DISPONIBILITÀ ---
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
            client.query("SELECT * FROM corse WHERE stato IN ('prenotabile', 'in_corso', 'da_attivare') AND start_datetime > NOW() - INTERVAL '1 hour'")
        ]);

        // Pulizia indici Redis vecchi se necessario (opzionale: flushdb o cancellazione selettiva)
        
        vRes.rows.forEach(v => upsertVeicolo(v));
        
        // Caricamento e indicizzazione Disponibilità (Slot)
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
    if (!redisClient || coords.length === 0) return;
    const newHashes = [...new Set(coords.map(p => ngeohash.encode(p[1], p[0], 5)))];
    const pipeline = redisClient.multi();
    newHashes.forEach(h => pipeline.sAdd(`corsa:in_area:${h}`, corsaId.toString()));
    pipeline.set(`corsa:hashes:${corsaId}`, JSON.stringify(newHashes));
    await pipeline.exec();
}

async function aggiornaIndiciDisponibilita(d) {
    if (!redisClient || !d.lat || !d.lon) return;
    const hash = ngeohash.encode(Number(d.lat), Number(d.lon), 5);
    // Usiamo una chiave separata per non mischiare corse e slot liberi
    await redisClient.sAdd(`slot:in_area:${hash}`, d.id.toString());
}