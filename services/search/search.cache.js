import { pool } from '../../db/db.js';
import ngeohash from 'ngeohash';
import polyline from '@mapbox/polyline';
import { redisClient } from '../../redis.js';

const SYNC_TTL_MS = 60000;
let syncPromise = null;
let mutationVersion = 0;

function changed(store = CacheStore) {
    if (store === CacheStore) mutationVersion++;
}

async function inBatches(items, operation) {
    const values = [...items];
    for (let offset = 0; offset < values.length; offset += 8) {
        // Attendere l'intero blocco anche in caso di errore: nessuna scrittura
        // abbandonata puo sovrapporsi al successivo tentativo di caricamento.
        const results = await Promise.allSettled(values.slice(offset, offset + 8).map(operation));
        const failed = results.find(result => result.status === 'rejected');
        if (failed) throw failed.reason;
    }
}

export const CacheStore = {
    veicoliCache: new Map(),
    disponibilitaCache: new Map(),
    veicoloToDisponibilita: new Map(), 
    corseCache: new Map(),
    tratteCache: new Map(),
    tratteByCorsa: new Map(),
    prenotazioniCache: new Map(),
    direttriciCache: new Map(),
    nodiCache: new Map(),
    lastSync: 0
};

// --- GESTIONE DISPONIBILITÀ ---
export const upsertDisponibilita = (d, store = CacheStore) => {
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
    
    changed(store);
    store.disponibilitaCache.set(Number(d.id), normalized);
    const current = store.veicoloToDisponibilita.get(normalized.veicolo_id);
    if (!current || Number(current.id) <= Number(d.id)) {
        store.veicoloToDisponibilita.set(normalized.veicolo_id, normalized);
    }
    
    console.log(`📦 [CACHE DISPONIBILITÀ] Salvato/Aggiornato -> Veicolo ID: ${normalized.veicolo_id} (Disponibilità ID: ${d.id}), Slot attivo: ${normalized.is_slot}`);
};

export const removeDisponibilita = async (disponibilitaId) => {
    const id = Number(disponibilitaId);
    const d = CacheStore.disponibilitaCache.get(id);
    if (d) {
        changed();
        CacheStore.disponibilitaCache.delete(id);
        const remaining = [...CacheStore.disponibilitaCache.values()]
            .filter(x => x.veicolo_id === d.veicolo_id)
            .sort((a, b) => Number(b.id) - Number(a.id))[0];
        if (remaining) CacheStore.veicoloToDisponibilita.set(d.veicolo_id, remaining);
        else CacheStore.veicoloToDisponibilita.delete(d.veicolo_id);
        const lat = d.lat_live !== null && d.lat_live !== undefined ? d.lat_live : d.lat_base;
        const lon = d.lon_live !== null && d.lon_live !== undefined ? d.lon_live : d.lon_base;

        if (!remaining && redisClient && lat !== null && lat !== undefined && lon !== null && lon !== undefined) {
            const hash = ngeohash.encode(Number(lat), Number(lon), 5);
            await redisClient.sRem(`slot:in_area:${hash}`, d.veicolo_id.toString());
        }
        if (!remaining) await syncGeoIndex('slot', d.veicolo_id, []);
        console.log(`🗑 [CACHE DISPONIBILITÀ] Rimossa disponibilità ID: ${id} per Veicolo ID: ${d.veicolo_id}`);
    }
};

// --- GESTIONE ENTITÀ ---
export const upsertVeicolo = (v, store = CacheStore) => {
    if (!CacheStore || !CacheStore.veicoliCache) return;
    changed(store);
    store.veicoliCache.set(Number(v.id), v);
};

export const removeVeicolo = async (veicoloId) => {
    changed();
    CacheStore.veicoliCache.delete(Number(veicoloId));
};

export const upsertPrenotazione = async (prenotazione) => {
    if (!CacheStore) return;
    CacheStore.prenotazioniCache.set(Number(prenotazione.id), prenotazione);
};

export const upsertCorsa = async (c, indicizzare = false, store = CacheStore) => {
    changed(store);
    c.partenza_prevista = c.start_datetime;
    c.arrivo_previsto = c.arrivo_datetime;

    // 🗺️ Mappatura di sicurezza per garantire che l'engine legga sempre le coordinate dal DB
    c.origine_lat = c.origine_lat || c.lat_partenza || c.start_lat;
    c.origine_lon = c.origine_lon || c.lon_partenza || c.start_lon || c.lng_partenza;
    c.dest_lat = c.dest_lat || c.lat_arrivo || c.dest_latitudine;
    c.dest_lon = c.dest_lon || c.lon_arrivo || c.dest_longitudine || c.lng_arrivo;

    // --- 📏 PRESA DEL DATO PURA (Senza nessuna normalizzazione o divisione) ---
    const rawDistanza = Number(
        c.km_totali_percorso || 
        c.distanza_totale || 
        c.distanza || 
        c.km_totali || 
        c.lunghezza || 
        0
    );

    c.km_totali_percorso = rawDistanza;
    c.distanza = rawDistanza;

    if (c.percorso_polyline) {
        try {
            c.decodedCoords = polyline.decode(c.percorso_polyline);
        } catch (e) {
            c.decodedCoords = [];
        }
    }
    
    store.corseCache.set(Number(c.id), c);
    if (indicizzare && c.decodedCoords && c.decodedCoords.length > 0) {
        await aggiornaIndiciRedis(c.id, c.decodedCoords);
    }
};

export const removeCorsa = async (corsaId) => {
    changed();
    const id = Number(corsaId);
    CacheStore.corseCache.delete(id);
    const errors = [];
    try { await syncGeoIndex('corsa', id, []); } catch (e) { errors.push(e); }
    for (const trattaId of [...(CacheStore.tratteByCorsa.get(id) || [])]) {
        try { await removeTratta(trattaId); } catch (e) { errors.push(e); }
    }
    if (errors.length) throw new AggregateError(errors, 'REDIS_INDEX_CLEANUP_FAILED');
};

export async function upsertTratta(t, indicizzare = false, store = CacheStore) {
    changed(store);
    const id = Number(t.id), corsaId = Number(t.corsa_id);
    if (!Number.isSafeInteger(id) || !Number.isSafeInteger(corsaId)) throw new Error('ID tratta/corsa non valido');
    if (!['andata', 'ritorno'].includes(t.direzione)) throw new Error('Direzione non valida');
    let decodedCoords = [];
    try {
        if (t.percorso_polyline) decodedCoords = polyline.decode(t.percorso_polyline);
        if (decodedCoords.length < 2) decodedCoords = [];
    } catch (err) {
        console.warn(`[CACHE TRATTE] Polyline non valida ${id}: ${err.message}`);
    }
    const old = store.tratteCache.get(id);
    if (old && Number(old.corsa_id) !== corsaId) store.tratteByCorsa.get(Number(old.corsa_id))?.delete(id);
    const normalized = { ...t, id, corsa_id: corsaId, decodedCoords };
    store.tratteCache.set(id, normalized);
    if (!store.tratteByCorsa.has(corsaId)) store.tratteByCorsa.set(corsaId, new Set());
    store.tratteByCorsa.get(corsaId).add(id);
    if (indicizzare) await syncGeoIndex('tratta', id, decodedCoords);
    return normalized;
}

export async function removeTratta(trattaId) {
    changed();
    const id = Number(trattaId);
    const t = CacheStore.tratteCache.get(id);
    CacheStore.tratteCache.delete(id);
    if (t) {
        const set = CacheStore.tratteByCorsa.get(Number(t.corsa_id));
        set?.delete(id);
        if (set?.size === 0) CacheStore.tratteByCorsa.delete(Number(t.corsa_id));
    }
    await syncGeoIndex('tratta', id, []);
};

// --- SYNC ENGINE ---
export function loadCachesUltra(force = false) {
    if (syncPromise) return syncPromise;
    if (!force && (Date.now() - CacheStore.lastSync < SYNC_TTL_MS)) return;
    syncPromise = refreshCachesUltra().catch(error => {
        if (error.message !== 'CACHE_CHANGED_DURING_SYNC') throw error;
        return refreshCachesUltra();
    }).finally(() => { syncPromise = null; });
    return syncPromise;
}

async function refreshCachesUltra() {
    const version = mutationVersion;
    const next = Object.fromEntries(Object.entries(CacheStore)
        .filter(([key, value]) => value instanceof Map && key !== 'prenotazioniCache')
        .map(([key]) => [key, new Map()]));
    const client = await pool.connect();
    let readTx = false;
    let released = false;
    try {
        await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        readTx = true;
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
        `);

        console.log(`🔍 [SYNC DISPONIBILITÀ] Righe caricate senza filtro NOW(): ${dRes.rows.length}`);

        if (dRes.rows.length === 0) {
            console.warn("⚠️ [SYNC] Nessuna disponibilità trovata.");
        }

        const [vRes, cRes, dirRes, nodiRes, tratteRes] = await Promise.all([
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
            client.query(`SELECT id, nome, posizione, attivo FROM public.nodi_territoriali WHERE attivo = TRUE`),
            client.query(`SELECT t.* FROM public.corse_tratte t JOIN public.corse c ON c.id = t.corsa_id
                          WHERE c.tipo_corsa = 'condivisa' AND c.stato IN ('prenotabile','in_corso','da_attivare')`)
        ]);
        await client.query('COMMIT');
        readTx = false;
        client.release();
        released = true;
        
        vRes.rows.forEach(v => upsertVeicolo(v, next));
        
        dRes.rows.forEach(d => {
            console.log(`📋 [SYNC DEBUG] Processo disponibilità DB -> Veicolo ID: ${d.veicolo_id}, Start: ${d.start}, Fine: ${d.fine}`);
            upsertDisponibilita(d, next);
        });

        // Costruzione separata: i lettori non vedono snapshot parziali.
        for (const c of cRes.rows) await upsertCorsa(c, false, next);
        for (const t of tratteRes.rows) await upsertTratta(t, false, next);
        dirRes.rows.forEach(dir => next.direttriciCache.set(dir.id, dir));
        nodiRes.rows.forEach(nodo => next.nodiCache.set(String(nodo.id), nodo));

        // Ogni operazione Redis viene attesa; nessuna rejection abbandonata.
        await inBatches(next.veicoloToDisponibilita.values(), aggiornaIndiciDisponibilita);
        for (const [id, d] of CacheStore.veicoloToDisponibilita) {
            if (!next.veicoloToDisponibilita.has(id)) {
                const lat = d.lat_live ?? d.lat_base, lon = d.lon_live ?? d.lon_base;
                if (redisClient && lat != null && lon != null) {
                    await redisClient.sRem(`slot:in_area:${ngeohash.encode(Number(lat), Number(lon), 5)}`, String(id));
                }
                await syncGeoIndex('slot', id, []);
            }
        }
        await inBatches(next.corseCache.values(), c => syncGeoIndex('corsa', c.id, c.decodedCoords || []));
        await inBatches(next.tratteCache.values(), t => syncGeoIndex('tratta', t.id, t.decodedCoords));
        const activeTratte = new Set(tratteRes.rows.map(t => Number(t.id)));
        for (const id of [...CacheStore.tratteCache.keys()]) {
            if (!activeTratte.has(id)) await syncGeoIndex('tratta', id, []);
        }
        const activeCorse = new Set(cRes.rows.map(c => Number(c.id)));
        for (const id of [...CacheStore.corseCache.keys()]) {
            if (!activeCorse.has(id)) await syncGeoIndex('corsa', id, []);
        }
        
        if (version !== mutationVersion) {
            // Un CRUD ha aggiornato la cache durante gli await: non sovrascriverlo.
            CacheStore.lastSync = 0;
            throw new Error('CACHE_CHANGED_DURING_SYNC');
        }
        Object.assign(CacheStore, next);

        // Riconciliazione Redis globale sospesa fino al test di concorrenza.
        CacheStore.lastSync = Date.now();
        console.log(`✅ [SYNC] Completata con successo. Totale veicoli attivi in memoria (veicoloToDisponibilita): ${CacheStore.veicoloToDisponibilita.size}`);
    } catch (err) {
        console.error("❌ [SYNC] Errore critico durante il caricamento delle cache:", err);
        throw err;
    } finally {
        if (!released) {
            if (readTx) await client.query('ROLLBACK').catch(() => {});
            client.release();
        }
    }
}

async function aggiornaIndiciDisponibilita(d) {
    const lat = d.lat_live !== null && d.lat_live !== undefined ? d.lat_live : d.lat_base;
    const lon = d.lon_live !== null && d.lon_live !== undefined ? d.lon_live : d.lon_base;

    if (!redisClient || lat === null || lon === null || lat === undefined || lon === undefined) {
        console.warn(`⚠️ [REDIS INDEX] Impossibile indicizzare il veicolo ${d.veicolo_id}: coordinate mancanti (lat: ${lat}, lon: ${lon})`);
        return;
    }
    await syncGeoIndex('slot', d.veicolo_id, [[Number(lat), Number(lon)]]);
}

// Indici separati: corsa:in_area:* (legacy) e tratta:in_area:* (NCC).
// La chiave hashes permette di rimuovere le celle geografiche obsolete.
async function syncGeoIndex(prefix, id, coords) {
    if (!redisClient) return;
    const hashesKey = `${prefix}:hashes:${id}`;
    const stored = await redisClient.get(hashesKey);
    let oldHashes = [];
    try { oldHashes = stored ? JSON.parse(stored) : []; } catch { oldHashes = []; }
    const previous = new Set(Array.isArray(oldHashes) ? oldHashes : []);
    const next = new Set((coords || [])
        .filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1]))
        .map(p => ngeohash.encode(p[0], p[1], 5)));
    const tx = redisClient.multi();
    for (const hash of previous) if (!next.has(hash)) tx.sRem(`${prefix}:in_area:${hash}`, String(id));
    for (const hash of next) if (!previous.has(hash)) tx.sAdd(`${prefix}:in_area:${hash}`, String(id));
    if (next.size) tx.set(hashesKey, JSON.stringify([...next]));
    else tx.del(hashesKey);
    await tx.exec();
}

async function reconcileGeoIndexes(activeCorse, activeTratte) {
    if (!redisClient?.isReady) throw new Error('REDIS_NOT_READY_FOR_RECONCILIATION');
    for (const [prefix, activeIds] of [['corsa', activeCorse], ['tratta', activeTratte]]) {
        let removed = 0;
        for await (const keys of redisClient.scanIterator({ MATCH: `${prefix}:hashes:*`, COUNT: 100 })) {
            for (const key of keys) {
            const idText = key.slice(`${prefix}:hashes:`.length);
            const id = Number(idText);
            if (!Number.isSafeInteger(id) || id <= 0 || String(id) !== idText) throw new Error(`REDIS_INVALID_GEO_INDEX_KEY: ${key}`);
            if (!activeIds.has(id)) { await syncGeoIndex(prefix, id, []); removed++; }
        }
        }
        console.log(`[REDIS RECONCILE] ${prefix}: indici obsoleti rimossi=${removed}`);
    }
}

async function aggiornaIndiciRedis(corsaId, coords) {
    return syncGeoIndex('corsa', corsaId, coords);
}
