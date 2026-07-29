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

    let lat = Number(richiesta.coord?.lat ?? richiesta.lat);
    let lon = Number(richiesta.coord?.lon ?? richiesta.coord?.lng ?? richiesta.lon);
    let destLat = Number(richiesta.coordDest?.lat ?? richiesta.destLat);
    let destLon = Number(richiesta.coordDest?.lon ?? richiesta.destLon ?? richiesta.destLng);

    // Orari standard richiesti dall'utente
    let orarioAndataUtente = new Date(richiesta.start_datetime || new Date());
    let orarioRitornoUtente = richiesta.return_datetime ? new Date(richiesta.return_datetime) : null;

    let orarioEventoAndata = null;
    let orarioEventoRitorno = null;

    // Se la ricerca è legata a un evento, recuperiamo coordinate e orari dedicati
    if (richiesta.evento_id) {
        const { rows: eventoRows } = await pool.query(`
            SELECT lat, lng, data_inizio, data_fine FROM eventi WHERE id = $1
        `, [richiesta.evento_id]);

        if (eventoRows.length > 0) {
            const ev = eventoRows[0];
            destLat = destLat || ev.lat;
            destLon = destLon || ev.lng;
            orarioEventoAndata = new Date(ev.data_inizio);
            if (ev.data_fine) {
                const fineEvento = new Date(ev.data_fine);
                fineEvento.setMinutes(fineEvento.getMinutes() + 30);
                orarioEventoRitorno = fineEvento;
            }
            console.log(`🎟️ [SearchEngine] Evento [ID: ${richiesta.evento_id}] -> Dest: ${destLat},${destLon} | Inizio: ${ev.data_inizio}`);
        }
    }

    if (!lat || !lon || !destLat || !destLon) return formatResults(richiesta, []);

    const pStart = turf.point([lon, lat]);
    const postiRichiesti = Number(richiesta.posti_richiesti || 1);

    console.log(`🔍 [SearchEngine] Analisi tratta ${lat},${lon} -> ${destLat},${destLon}`);

    const info = await getDurataDistanza({ lat, lon }, { lat: destLat, lon: destLon });
    const distanzaMetri = (info.distanzaKm || 1) * 1000;

    // --- 1. CORSE DA CACHE (Condivise) ---
    const hash = ngeohash.encode(lat, lon, GEOHASH_PRECISION_TRATTA);
    const hashes = [hash, ...ngeohash.neighbors(hash)];
    const corsaResults = await Promise.all(hashes.map(h => redisClient.sMembers(`corsa:in_area:${h}`)));
    const corseCandidate = [...new Set(corsaResults.flat())].map(id => {
        const c = CacheStore.corseCache.get(Number(id));
        if (!c) return null;
        c.classe = determinaClasse(Number(c.indice_efficienza || 0));
        return c;
    }).filter(Boolean);

    const { corse: corseValide } = await filterDisponibilita({ 
        ...richiesta, 
        posti_richiesti: postiRichiesti,
        return_datetime: orarioRitornoUtente || orarioEventoRitorno 
    }, corseCandidate, []);
    
    const risultatiCondivise = corseValide.map(c => ({ 
        ...c, 
        tipo: 'condivisa', 
        is_pool: false, 
        distanza: c.distanza || distanzaMetri 
    }));

    // --- 2. CORSE PRIVATE ---
    const risultatiPrivati = [];
    for (const [veicoloId, disp] of CacheStore.veicoloToDisponibilita) {
        if (!disp.lat || !disp.lon) continue;
        const distVeicolo = turf.distance(pStart, turf.point([Number(disp.lon), Number(disp.lat)]), { units: 'kilometers' });
        
        if (distVeicolo < 50) {
            if (disp.is_slot && disp.disponibile !== false) {
                const cap = await getCapacitaDirettrice(disp.veicolo_id);
                
                risultatiPrivati.push({
                    id: `priv_${veicoloId}`, 
                    tipo: 'privata', 
                    veicolo_id: veicoloId, 
                    marca: disp.marca || disp.veicolo?.marca || '',
                    modello: disp.modello || disp.veicolo?.modello || '',
                    classe: disp.classe || 'STANDARD',
                    servizi: disp.servizi || {},
                    posti_disponibili: cap,
                    posti_totali: cap, 
                    distanza: distanzaMetri, 
                    is_pool: false,
                    is_privato: true
                });
            }
        }
    }

    // --- 3. POP-BUS (Raccogliamo sia i pool dell'orario utente che quelli dell'evento) ---
    const orariRicercaPool = [orarioAndataUtente];
    if (orarioEventoAndata) orariRicercaPool.push(orarioEventoAndata);

    let direttriciAttivateSet = new Map();

    for (const orarioTarget of orariRicercaPool) {
        const { rows: direttrici } = await pool.query(`
            SELECT d.id, d.stato, d.partenza_prevista, d.veicolo_id, d.tipo_servizio, MIN(s1.ordine_sequenziale) as min_seq, MAX(s2.ordine_sequenziale) as max_seq
            FROM direttrici_virtuali d
            JOIN segmenti s1 ON d.id = s1.direttrice_id
            JOIN segmenti s2 ON d.id = s2.direttrice_id
            WHERE d.stato IN ('in_formazione', 'in_attesa_autista', 'confermata')
            AND d.partenza_prevista BETWEEN $1::timestamptz - INTERVAL '2 hours' AND $1::timestamptz + INTERVAL '2 hours'
            GROUP BY d.id, d.stato, d.partenza_prevista, d.veicolo_id, d.tipo_servizio
        `, [orarioTarget.toISOString()]);

        direttrici.forEach(d => direttriciAttivateSet.set(d.id, d));
    }

    const risultatiPool = (await Promise.all(Array.from(direttriciAttivateSet.values()).map(async (dir) => {
        const occupati = await getOccupazioneSegmenti(dir.id, dir.min_seq, dir.max_seq);
        const capacita = await getCapacitaDirettrice(dir.id);
        const disponibili = capacita - occupati;
        
        if (disponibili >= postiRichiesti) {
            const dispVeicolo = CacheStore.veicoloToDisponibilita.get(dir.veicolo_id) || {};
            return { 
                id: `pop_${dir.id}`, 
                tipo: 'pop-bus', 
                direttrice_id: dir.id, 
                veicolo_id: dir.veicolo_id,
                marca: dispVeicolo.marca || dispVeicolo.veicolo?.marca || '',
                modello: dispVeicolo.modello || dispVeicolo.veicolo?.modello || '',
                partenza_prevista: dir.partenza_prevista,
                posti_disponibili: disponibili, 
                posti_totali: capacita, 
                distanza: distanzaMetri, 
                is_pool: true,
                include_ritorno: !!orarioRitornoUtente || !!orarioEventoRitorno
            };
        }
        return null;
    }))).filter(Boolean);

    let risultatiFinali = [...risultatiCondivise, ...risultatiPrivati, ...risultatiPool];
    console.log(`📊 [SearchEngine] Risultati trovati: Condivise=${risultatiCondivise.length}, Private=${risultatiPrivati.length}, Pool=${risultatiPool.length}`);

    // --- LOGICA PROATTIVA DISABILITATA ---
    // Le scritture automatiche su database (INSERT) sono state rimosse per evitare 
    // la duplicazione di record non confermati in stato 'in_attesa'.
    if (risultatiPool.length === 0) {
        const veicoliDisponibili = Array.from(CacheStore.veicoloToDisponibilita.entries())
            .filter(([_, disp]) => disp.disponibile === true)
            .map(([id, _]) => id);
        
        risultatiFinali.push({
            id: `virtual_pop_pending`,
            tipo: 'pop-bus',
            is_pool: true,
            veicoli_pool_ids: veicoliDisponibili,
            stato: 'in_attesa',
            distanza: distanzaMetri,
            distanzaTotaleRotte: distanzaMetri,
            messaggio: `Nessun pool attivo trovato, opzioni virtuali pronte per la selezione.`
        });
    }

    return await formatResults({ 
        ...richiesta, 
        distanzaMetri, 
        return_datetime: orarioRitornoUtente || orarioEventoRitorno 
    }, risultatiFinali);
}