import { pool } from '../../db/db.js';
import ngeohash from 'ngeohash';
import polyline from 'polyline';
import { redisClient } from '../../redis.js';

const SYNC_TTL_MS = 60000;

export const CacheStore = {
    veicoliCache: new Map(),
    disponibilitaCache: new Map(),
    veicoloToDisponibilita: new Map(), 
    corseCache: new Map(),
    prenotazioniCache: new Map(),
    direttriciCache: new Map(),
    nodiCache: new Map(),
    lastSync: 0
};

// --- GESTIONE DISPONIBILITÀ ---
export const upsertDisponibilita = (d) => {
    if (!CacheStore) return;
    const normalized = {
        ...d,
        veicolo_id: Number(d.veicolo_id),
        driver_id: Number(d.driver_id), 
        is_slot: true,
        disponibile: d.disponibile !== undefined ? d.disponibile : true,
        tipo: String(d.servizi || d.tipo_veicolo || 'privata').toLowerCase().trim(),
        inattivita: typeof d.inattivita === 'string' ? JSON.parse(d.inattivita) : (d.inattivita || [])
    };
    
    CacheStore.disponibilitaCache.set(Number(d.id), normalized);
    CacheStore.veicoloToDisponibilita.set(Number(d.veicolo_id), normalized);
    
    console.log(`📦 [CACHE DISPONIBILITÀ] Salvato/Aggiornato -> Veicolo ID: ${normalized.veicolo_id} (Disponibilità ID: ${d.id}), Slot attivo: ${normalized.is_slot}`);
};

export const removeDisponibilita = async (disponibilitaId) => {
    const id = Number(disponibilitaId);
    const d = CacheStore.disponibilitaCache.get(id);
    if (d) {
        const lat = d.lat_live !== null && d.lat_live !== undefined ? d.lat_live : d.lat_base;
        const lon = d.lon_live !== null && d.lon_live !== undefined ? d.lon_live : d.lon_base;

        if (lat !== null && lat !== undefined && lon !== null && lon !== undefined) {
            const hash = ngeohash.encode(Number(lat), Number(lon), 5);
            await redisClient.sRem(`slot:in_area:${hash}`, d.veicolo_id.toString());
        }
        CacheStore.veicoloToDisponibilita.delete(Number(d.veicolo_id));
        CacheStore.disponibilitaCache.delete(id);
        console.log(`🗑️ [CACHE DISPONIBILITÀ] Rimossa disponibilità ID: ${id} per Veicolo ID: ${d.veicolo_id}`);
    }
};

// --- GESTIONE ENTITÀ ---
export const upsertVeicolo = (v) => {
    if (!CacheStore || !CacheStore.veicoliCache) return;
    CacheStore.veicoliCache.set(Number(v.id), v);
};

export const removeVeicolo = async (veicoloId) => {
    CacheStore.veicoliCache.delete(Number(veicoloId));
};

export const upsertPrenotazione = async (prenotazione) => {
    if (!CacheStore) return;
    CacheStore.prenotazioniCache.set(Number(prenotazione.id), prenotazione);
};

export const upsertCorsa = async (c, indicizzare = false) => {
    c.partenza_prevista = c.start_datetime;
    c.arrivo_previsto = c.arrivo_datetime;

    // 🗺️ Mappatura di sicurezza per garantire che l'engine legga sempre le coordinate dal DB
    c.origine_lat = c.origine_lat || c.lat_partenza || c.start_lat;
    c.origine_lon = c.origine_lon || c.lon_partenza || c.start_lon || c.lng_partenza;
    c.dest_lat = c.dest_lat || c.lat_arrivo || c.dest_latitudine;
    c.dest_lon = c.dest_lon || c.lon_arrivo || c.dest_longitudine || c.lng_arrivo;

    if (c.percorso_polyline) {
        c.decodedCoords = polyline.decode(c.percorso_polyline);
    }
    
    CacheStore.corseCache.set(Number(c.id), c);
    if (indicizzare && c.decodedCoords) await aggiornaIndiciRedis(c.id, c.decodedCoords);
};

export const removeCorsa = async (corsaId) => {
    const id = Number(corsaId);
    CacheStore.corseCache.delete(id);
};

// --- SYNC ENGINE ---
export async function loadCachesUltra(force = false) {
    if (!force && (Date.now() - CacheStore.lastSync < SYNC_TTL_MS)) return;
    
    const client = await pool.connect();
    try {
        console.log(`⏳ [SYNC] Inizio caricamento cache...`);
        
        let dRes = await client.query(`
            SELECT dv.*, v.driver_id, v.servizi, v.tipo, v.marca, v.modello, v.rating,
                   -- Posizione BASE (dal veicolo)
                   ST_Y(v.coord::geometry) as lat_base, ST_X(v.coord::geometry) as lon_base,
                   -- Posizione LIVE (dalla tabella posizioni)
                   ST_Y(pv.coord::geometry) as lat_live, ST_X(pv.coord::geometry) as lon_live
            FROM disponibilita_veicolo dv 
            JOIN veicolo v ON dv.veicolo_id = v.id 
            LEFT JOIN LATERAL (
                SELECT coord 
                FROM posizione_veicolo 
                WHERE veicolo_id = v.id 
                ORDER BY "timestamp" DESC 
                LIMIT 1
            ) pv ON true
            ORDER BY dv.id DESC
            LIMIT 100
        `);

        console.log(`🔍 [SYNC DISPONIBILITÀ] Righe caricate senza filtro NOW(): ${dRes.rows.length}`);

        if (dRes.rows.length === 0) {
            console.warn("⚠️ [SYNC] Nessuna disponibilità trovata.");
        }

        const [vRes, cRes, dirRes, nodiRes] = await Promise.all([
            client.query(`SELECT id, ST_Y(coord::geometry) as lat, ST_X(coord::geometry) as lon, posti_totali, marca, modello, rating, servizi FROM veicolo`),
            client.query(`
                SELECT c.*, 
                       ST_Y(c.origine::geometry) as origine_lat, 
                       ST_X(c.origine::geometry) as origine_lon,
                       ST_Y(c.destinazione::geometry) as dest_lat, 
                       ST_X(c.destinazione::geometry) as dest_lon,
                       v.marca, v.modello, v.rating, v.servizi 
                FROM corse c 
                LEFT JOIN veicolo v ON c.veicolo_id = v.id 
                WHERE c.stato IN ('prenotabile', 'in_corso', 'da_attivare')
            `),
            client.query(`SELECT * FROM direttrici_virtuali WHERE stato IN ('in_formazione', 'in_attesa_autista', 'confermata')`),
            client.query(`SELECT * FROM nodi_direttrice`)
        ]);
        
        vRes.rows.forEach(v => upsertVeicolo(v));
        
        dRes.rows.forEach(d => {
            console.log(`📋 [SYNC DEBUG] Processo disponibilità DB -> Veicolo ID: ${d.veicolo_id}, Start: ${d.start}, Fine: ${d.fine}`);
            upsertDisponibilita({ ...d, disponibile: true });
            aggiornaIndiciDisponibilita(d); 
        });

        await Promise.all(cRes.rows.map(c => upsertCorsa(c, true)));
        
        CacheStore.direttriciCache.clear();
        dirRes.rows.forEach(dir => CacheStore.direttriciCache.set(dir.id, dir));
        CacheStore.nodiCache.clear();
        nodiRes.rows.forEach(nodo => {
            const list = CacheStore.nodiCache.get(nodo.direttrice_id) || [];
            list.push(nodo);
            CacheStore.nodiCache.set(nodo.direttrice_id, list);
        });

        CacheStore.lastSync = Date.now();
        console.log(`✅ [SYNC] Completata con successo. Totale veicoli attivi in memoria (veicoloToDisponibilita): ${CacheStore.veicoloToDisponibilita.size}`);
    } catch (err) {
        console.error("❌ [SYNC] Errore critico durante il caricamento delle cache:", err);
    } finally {
        client.release();
    }
}

async function aggiornaIndiciDisponibilita(d) {
    const lat = d.lat_live !== null && d.lat_live !== undefined ? d.lat_live : d.lat_base;
    const lon = d.lon_live !== null && d.lon_live !== undefined ? d.lon_live : d.lon_base;

    if (!redisClient || lat === null || lon === null || lat === undefined || lon === undefined) {
        console.warn(`⚠️ [REDIS INDEX] Impossibile indicizzare il veicolo ${d.veicolo_id}: coordinate mancanti (lat: ${lat}, lon: ${lon})`);
        return;
    }
    const hash = ngeohash.encode(Number(lat), Number(lon), 5);
    await redisClient.sAdd(`slot:in_area:${hash}`, d.veicolo_id.toString());
}

async function aggiornaIndiciRedis(corsaId, coords) {
    if (!redisClient || !coords || coords.length === 0) return;
    const newHashes = [...new Set(coords.map(p => ngeohash.encode(p[0], p[1], 5)))];
    const pipeline = redisClient.multi();
    newHashes.forEach(h => pipeline.sAdd(`corsa:in_area:${h}`, corsaId.toString()));
    pipeline.set(`corsa:hashes:${corsaId}`, JSON.stringify(newHashes));
    await pipeline.exec();
}