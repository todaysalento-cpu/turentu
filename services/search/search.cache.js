import { pool } from '../../db/db.js';
import ngeohash from 'ngeohash';
import polyline from 'polyline';
import { redisClient } from '../../redis.js';

const SYNC_TTL_MS = 60000;

export const CacheStore = {
    veicoliCache: new Map(),
    disponibilitaCache: new Map(),
    // Mappa di supporto per accedere alla disponibilità tramite veicolo_id
    veicoloToDisponibilita: new Map(), 
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
    
    // Indici principali
    CacheStore.disponibilitaCache.set(Number(d.id), normalized);
    // Indice per lookup rapido via veicolo_id (usato dalla ricerca geografica)
    CacheStore.veicoloToDisponibilita.set(Number(d.veicolo_id), normalized);
};

export const removeDisponibilita = async (disponibilitaId) => {
    const id = Number(disponibilitaId);
    const d = CacheStore.disponibilitaCache.get(id);
    
    if (d && d.lat && d.lon) {
        const hash = ngeohash.encode(Number(d.lat), Number(d.lon), 5);
        // Rimuoviamo usando il veicolo_id come da nuova logica
        await redisClient.sRem(`slot:in_area:${hash}`, d.veicolo_id.toString());
    }
    
    if (d) CacheStore.veicoloToDisponibilita.delete(Number(d.veicolo_id));
    CacheStore.disponibilitaCache.delete(id);
    console.log(`🗑️ [CACHE] Disponibilità ${id} rimossa.`);
};

// --- GESTIONE ALTRE ENTITÀ ---
export const upsertPrenotazione = async (prenotazione) => {
    CacheStore.prenotazioniCache.set(Number(prenotazione.id), prenotazione);
};

export const upsertVeicolo = (v) => {
    CacheStore.veicoliCache.set(Number(v.id), v);
};

export const removeVeicolo = async (veicoloId) => {
    CacheStore.veicoliCache.delete(Number(veicoloId));
};

// --- GESTIONE CORSE ---
export const upsertCorsa = async (c, indicizzare = false) => {
    if (c.percorso_polyline) {
        c.decodedCoords = polyline.decode(c.percorso_polyline);
    }
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
};

// --- SYNC ENGINE ---
export async function loadCachesUltra(force = false) {
    if (!force && (Date.now() - CacheStore.lastSync < SYNC_TTL_MS)) return;
    
    const client = await pool.connect();
    try {
        const [vRes, dRes, cRes] = await Promise.all([
            // Query veicoli con metadati
            client.query(`
                SELECT 
                    id, 
                    ST_Y(coord::geometry) as lat, 
                    ST_X(coord::geometry) as lon, 
                    posti_totali,
                    marca,
                    modello,
                    rating,
                    servizi
                FROM veicolo
            `),
            // Query disponibilità con JOIN veicolo
            client.query(`SELECT dv.*, v.driver_id, ST_Y(v.coord::geometry) as lat, ST_X(v.coord::geometry) as lon 
                          FROM disponibilita_veicolo dv 
                          JOIN veicolo v ON dv.veicolo_id = v.id`),
            // AGGIORNATA: Query corse con JOIN per recuperare i dettagli del veicolo
            client.query(`
                SELECT 
                    c.*, 
                    v.marca, 
                    v.modello, 
                    v.rating, 
                    v.servizi 
                FROM corse c
                LEFT JOIN veicolo v ON c.veicolo_id = v.id
                WHERE c.stato IN ('prenotabile', 'in_corso', 'da_attivare') 
                AND c.start_datetime > NOW() - INTERVAL '1 hour'
            `)
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
        throw err;
    } finally {
        client.release();
    }
}

// --- UTILS REDIS ---
async function aggiornaIndiciRedis(corsaId, coords) {
    if (!redisClient || !coords || coords.length === 0) return;
    const newHashes = [...new Set(coords.map(p => ngeohash.encode(p[0], p[1], 5)))];
    const pipeline = redisClient.multi();
    newHashes.forEach(h => pipeline.sAdd(`corsa:in_area:${h}`, corsaId.toString()));
    pipeline.set(`corsa:hashes:${corsaId}`, JSON.stringify(newHashes));
    await pipeline.exec();
}

async function aggiornaIndiciDisponibilita(d) {
    if (!redisClient || !d.lat || !d.lon) return;
    const hash = ngeohash.encode(Number(d.lat), Number(d.lon), 5);
    await redisClient.sAdd(`slot:in_area:${hash}`, d.veicolo_id.toString());
}