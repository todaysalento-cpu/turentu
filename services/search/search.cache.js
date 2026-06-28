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

// --- GESTIONE DISPONIBILITÀ (UNIVERSALE) ---
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
};

// --- GESTIONE ENTITÀ ---
export const upsertVeicolo = (v) => {
    if (!CacheStore || !CacheStore.veicoliCache) return;
    CacheStore.veicoliCache.set(Number(v.id), v);
};

export const upsertCorsa = async (c, indicizzare = false) => {
    if (c.percorso_polyline) {
        c.decodedCoords = polyline.decode(c.percorso_polyline);
    }
    CacheStore.corseCache.set(Number(c.id), c);
    if (indicizzare && c.decodedCoords) await aggiornaIndiciRedis(c.id, c.decodedCoords);
};

// --- SYNC ENGINE ---
export async function loadCachesUltra(force = false) {
    if (!force && (Date.now() - CacheStore.lastSync < SYNC_TTL_MS)) return;
    
    const client = await pool.connect();
    try {
        console.log(`⏳ [SYNC] Inizio caricamento cache...`);
        
        // 1. Query principale con filtro temporale
        let dRes = await client.query(`
            SELECT dv.*, v.driver_id, v.servizi, v.tipo, 
                   ST_Y(v.coord::geometry) as lat, ST_X(v.coord::geometry) as lon 
            FROM disponibilita_veicolo dv 
            JOIN veicolo v ON dv.veicolo_id = v.id 
            WHERE NOW() BETWEEN dv.start AND dv.fine
        `);

        // 2. Logica di Fallback se non ci sono slot attivi ora
        if (dRes.rows.length === 0) {
            console.warn("⚠️ [SYNC] Nessuno slot attivo trovato, fallback su ultimi 50 record.");
            dRes = await client.query(`
                SELECT dv.*, v.driver_id, v.servizi, v.tipo, 
                       ST_Y(v.coord::geometry) as lat, ST_X(v.coord::geometry) as lon 
                FROM disponibilita_veicolo dv 
                JOIN veicolo v ON dv.veicolo_id = v.id 
                LIMIT 50
            `);
        }

        const [vRes, cRes, dirRes, nodiRes] = await Promise.all([
            client.query(`SELECT id, ST_Y(coord::geometry) as lat, ST_X(coord::geometry) as lon, posti_totali, marca, modello, rating, servizi FROM veicolo`),
            client.query(`SELECT c.*, v.marca, v.modello, v.rating, v.servizi FROM corse c LEFT JOIN veicolo v ON c.veicolo_id = v.id WHERE c.stato IN ('prenotabile', 'in_corso', 'da_attivare') AND c.start_datetime > NOW() - INTERVAL '1 hour'`),
            client.query(`SELECT * FROM direttrici_virtuali WHERE stato IN ('in_formazione', 'in_attesa_autista', 'confermata')`),
            client.query(`SELECT * FROM nodi_direttrice`)
        ]);
        
        vRes.rows.forEach(v => upsertVeicolo(v));
        dRes.rows.forEach(d => {
            upsertDisponibilita({ ...d, disponibile: true });
            aggiornaIndiciDisponibilita(d); 
        });

        await Promise.all(cRes.rows.map(c => upsertCorsa(c, true)));
        
        // Pulizia e popolamento direttrici/nodi
        CacheStore.direttriciCache.clear();
        dirRes.rows.forEach(dir => CacheStore.direttriciCache.set(dir.id, dir));
        CacheStore.nodiCache.clear();
        nodiRes.rows.forEach(nodo => {
            const list = CacheStore.nodiCache.get(nodo.direttrice_id) || [];
            list.push(nodo);
            CacheStore.nodiCache.set(nodo.direttrice_id, list);
        });

        CacheStore.lastSync = Date.now();
        console.log(`✅ [SYNC] Completata. Veicoli attivi: ${CacheStore.veicoloToDisponibilita.size}`);
    } catch (err) {
        console.error("❌ [SYNC] Errore critico:", err);
    } finally {
        client.release();
    }
}

async function aggiornaIndiciDisponibilita(d) {
    if (!redisClient || !d.lat || !d.lon) return;
    const hash = ngeohash.encode(Number(d.lat), Number(d.lon), 5);
    await redisClient.sAdd(`slot:in_area:${hash}`, d.veicolo_id.toString());
}