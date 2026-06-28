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
    // Normalizzazione critica per il matching nel SearchEngine
    const rawTipo = d.servizi || d.tipo_veicolo || '';
    const normalizedTipo = String(rawTipo).toLowerCase().trim();

    const normalized = {
        ...d,
        veicolo_id: Number(d.veicolo_id),
        driver_id: Number(d.driver_id), 
        is_slot: true,
        tipo: normalizedTipo, // Normalizzato a minuscolo per confronto sicuro
        inattivita: typeof d.inattivita === 'string' ? JSON.parse(d.inattivita) : (d.inattivita || [])
    };
    
    CacheStore.disponibilitaCache.set(Number(d.id), normalized);
    CacheStore.veicoloToDisponibilita.set(Number(d.veicolo_id), normalized);
};

export const removeDisponibilita = async (disponibilitaId) => {
    const id = Number(disponibilitaId);
    const d = CacheStore.disponibilitaCache.get(id);
    
    if (d && d.lat && d.lon) {
        const hash = ngeohash.encode(Number(d.lat), Number(d.lon), 5);
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

// --- SYNC ENGINE CON LOG DIAGNOSTICI ---
export async function loadCachesUltra(force = false) {
    if (!force && (Date.now() - CacheStore.lastSync < SYNC_TTL_MS)) return;
    
    const client = await pool.connect();
    try {
        console.log(`⏳ [SYNC] Inizio caricamento cache...`);
        const [vRes, dRes, cRes, dirRes, nodiRes] = await Promise.all([
            client.query(`SELECT id, ST_Y(coord::geometry) as lat, ST_X(coord::geometry) as lon, posti_totali, marca, modello, rating, servizi FROM veicolo`),
            client.query(`SELECT dv.*, v.driver_id, v.servizi, v.tipo_veicolo, ST_Y(v.coord::geometry) as lat, ST_X(v.coord::geometry) as lon FROM disponibilita_veicolo dv JOIN veicolo v ON dv.veicolo_id = v.id`),
            client.query(`SELECT c.*, v.marca, v.modello, v.rating, v.servizi FROM corse c LEFT JOIN veicolo v ON c.veicolo_id = v.id WHERE c.stato IN ('prenotabile', 'in_corso', 'da_attivare') AND c.start_datetime > NOW() - INTERVAL '1 hour'`),
            client.query(`SELECT * FROM direttrici_virtuali WHERE stato IN ('in_formazione', 'in_attesa_autista', 'confermata')`),
            client.query(`SELECT * FROM nodi_direttrice`)
        ]);
        
        console.log(`🔍 [CACHE DEBUG] Query DB - Veicoli: ${vRes.rows.length}, Disp: ${dRes.rows.length}`);

        vRes.rows.forEach(v => upsertVeicolo(v));
        
        dRes.rows.forEach(d => {
            upsertDisponibilita(d);
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

        // LOG DI VERIFICA FINALE
        console.log(`📦 [CACHE DEBUG] Totale veicoli in cache: ${CacheStore.veicoliCache.size}`);
        console.log(`📦 [CACHE DEBUG] Totale disponibilità in cache: ${CacheStore.veicoloToDisponibilita.size}`);
        
        // Verifica campionata (se ne hai, stampa il primo)
        const samples = Array.from(CacheStore.veicoloToDisponibilita.values()).slice(0, 2);
        samples.forEach(s => console.log(`🔍 [CACHE SAMPLE] Veicolo ID ${s.veicolo_id} | Tipo normalizzato: '${s.tipo}'`));

        CacheStore.lastSync = Date.now();
        console.log(`✅ [SYNC] Completata con successo.`);
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