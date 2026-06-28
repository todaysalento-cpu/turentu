import * as turf from '@turf/turf';
import ngeohash from 'ngeohash';
import { redisClient } from '../../redis.js';
import { pool } from '../../db/db.js';
import { loadCachesUltra, CacheStore } from './search.cache.js'; 
import { filterDisponibilita } from './engine/availability.engine.js';
import { formatResults } from './formatter/search.formatter.js';
import { getDurataDistanza } from '../../utils/maps.util.js';

const GEOHASH_PRECISION_TRATTA = 5;

function determinaClasse(indice) {
    if (indice <= 0.3) return 'SAVER';
    if (indice <= 1.5) return 'STANDARD';
    return 'EXPRESS';
}

async function getNearestNode(lat, lon) {
    const { rows } = await pool.query(`
        SELECT id FROM nodi_direttrice 
        ORDER BY posizione <-> ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography 
        LIMIT 1
    `, [lon, lat]);
    return rows[0];
}

async function getCapacitaDirettrice(direttriceId) {
    const { rows } = await pool.query(`
        SELECT COALESCE(SUM(v.posti_totali), 0) as capacita
        FROM direttrici_virtuali d
        JOIN veicolo v ON v.id = d.veicolo_id
        WHERE d.id = $1
    `, [direttriceId]);
    return Number(rows[0]?.capacita || 0);
}

async function getOccupazioneSegmenti(direttriceId, seqStart, seqEnd) {
    const { rows } = await pool.query(`
        SELECT COALESCE(SUM(posti_occupati), 0) as occupati
        FROM segmenti
        WHERE direttrice_id = $1 
        AND ordine_sequenziale BETWEEN $2 AND $3
    `, [direttriceId, seqStart, seqEnd]);
    return Number(rows[0]?.occupati || 0);
}

export async function cercaSlotUltra(richiesta) {
    await loadCachesUltra();

    const lat = Number(richiesta.coord?.lat ?? richiesta.lat);
    const lon = Number(richiesta.coord?.lon ?? richiesta.coord?.lng ?? richiesta.lon);
    const destLat = Number(richiesta.coordDest?.lat);
    const destLon = Number(richiesta.coordDest?.lon ?? richiesta.coordDest?.lng);

    if (!lat || !lon || !destLat || !destLon) return formatResults(richiesta, []);

    const pStart = turf.point([lon, lat]);
    const postiRichiesti = Number(richiesta.posti_richiesti || 1);
    const orarioRichiesto = new Date(richiesta.start_datetime || new Date());

    console.log(`🔍 [SearchEngine] Analisi tratta ${lat},${lon} -> ${destLat},${destLon} per il ${orarioRichiesto.toISOString()}`);

    const info = await getDurataDistanza({ lat, lon }, { lat: destLat, lon: destLon });
    const distanzaMetri = (info.distanzaKm || 1) * 1000;

    // 1. CORSE DA CACHE (Logica esistente)
    const hash = ngeohash.encode(lat, lon, GEOHASH_PRECISION_TRATTA);
    const hashes = [hash, ...ngeohash.neighbors(hash)];
    const corsaResults = await Promise.all(hashes.map(h => redisClient.sMembers(`corsa:in_area:${h}`)));
    const corseCandidate = [...new Set(corsaResults.flat())].map(id => {
        const c = CacheStore.corseCache.get(Number(id));
        if (!c) return null;
        c.classe = determinaClasse(Number(c.indice_efficienza || 0));
        return c;
    }).filter(Boolean);

    const { corse: corseValide } = await filterDisponibilita({ ...richiesta, posti_richiesti: postiRichiesti }, corseCandidate, []);
    const risultatiCondivise = corseValide.map(c => ({ ...c, tipo: 'condivisa', is_pool: false, distanza: c.distanza || distanzaMetri }));

    // 3. POP-BUS (Con log di debug)
    const { rows: direttriciAttivate } = await pool.query(`
        SELECT d.id, d.stato, d.partenza_prevista, MIN(s1.ordine_sequenziale) as min_seq, MAX(s2.ordine_sequenziale) as max_seq
        FROM direttrici_virtuali d
        JOIN segmenti s1 ON d.id = s1.direttrice_id
        JOIN segmenti s2 ON d.id = s2.direttrice_id
        WHERE d.stato IN ('in_formazione', 'in_attesa_autista', 'confermata')
        AND d.partenza_prevista BETWEEN $1::timestamptz - INTERVAL '1 hour' AND $1::timestamptz + INTERVAL '1 hour'
        GROUP BY d.id
    `, [orarioRichiesto.toISOString()]);

    console.log(`🚌 [PopBus] Direttrici candidate trovate: ${direttriciAttivate.length}`);
    
    const risultatiPool = (await Promise.all(direttriciAttivate.map(async (dir) => {
        const occupati = await getOccupazioneSegmenti(dir.id, dir.min_seq, dir.max_seq);
        const capacita = await getCapacitaDirettrice(dir.id);
        const disponibili = capacita - occupati;
        console.log(`🚌 [PopBus] ID: ${dir.id}, Disp: ${disponibili}, Richiesti: ${postiRichiesti}`);
        
        if (disponibili >= postiRichiesti) {
            return { id: `pop_${dir.id}`, tipo: 'pop-bus', direttrice_id: dir.id, posti_disponibili: disponibili, posti_totali: capacita, distanza: distanzaMetri, is_pool: true };
        }
        return null;
    }))).filter(Boolean);

    const risultatiFinali = [...risultatiCondivise, ...risultatiPool]; // (Aggiungi qui eventuali altri risultati)

    // --- LOGICA DI FALLBACK (CODA DRT) ---
    if (risultatiFinali.length === 0) {
        console.log("⚠️ [SearchEngine] Nessun risultato trovato. Innesco coda DRT...");
        try {
            const startNode = await getNearestNode(lat, lon);
            const endNode = await getNearestNode(destLat, destLon);

            await pool.query(`
                INSERT INTO richieste_pop_bus (cliente_id, origine, destinazione, start_datetime, posti_richiesti, start_node_id, end_node_id, classe, stato)
                VALUES ($1, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography, ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography, $6, $7, $8, $9, $10, 'in_attesa')
            `, [richiesta.cliente_id, lon, lat, destLon, destLat, orarioRichiesto, postiRichiesti, startNode?.id, endNode?.id, richiesta.classe || 'STANDARD']);
            
            console.log("✅ [SearchEngine] Richiesta accodata con successo.");
            return formatResults({ ...richiesta, distanzaMetri }, [{
                tipo: 'richiesta_accettata',
                messaggio: "Nessuna corsa immediata. La richiesta è in coda per il prossimo ciclo di ottimizzazione."
            }]);
        } catch (err) {
            console.error("❌ Errore critico accodamento DRT:", err);
        }
    }

    return await formatResults({ ...richiesta, distanzaMetri }, risultatiFinali);
}