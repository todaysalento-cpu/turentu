import * as turf from '@turf/turf';
import ngeohash from 'ngeohash';
import { redisClient } from '../../redis.js';
import { pool } from '../../db/db.js';
import { loadCachesUltra, CacheStore } from './search.cache.js'; 
import { filterDisponibilita } from './engine/availability.engine.js';
import { formatResults } from './formatter/search.formatter.js';
import { getDurataDistanza } from '../../utils/maps.util.js';

const GEOHASH_PRECISION_TRATTA = 5;

/**
 * Helper: Determina la classe di servizio in base all'indice di efficienza
 */
function determinaClasse(indice) {
    if (indice <= 0.3) return 'SAVER';
    if (indice <= 1.5) return 'STANDARD';
    return 'EXPRESS';
}

/**
 * Calcolo occupazione dinamico basato su capacità reale del mezzo
 */
async function getOccupazioneSegmenti(direttriceId, seqStart, seqEnd) {
    const { rows } = await pool.query(`
        SELECT COALESCE(SUM(posti_occupati), 0) as totale_carico
        FROM segmenti
        WHERE direttrice_id = $1 
        AND ordine_sequenziale >= $2 
        AND ordine_sequenziale <= $3
    `, [direttriceId, seqStart, seqEnd]);
    
    return Number(rows[0]?.totale_carico || 0);
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

    const info = await getDurataDistanza({ lat, lon }, { lat: destLat, lon: destLon });
    const distanzaMetri = (info.distanzaKm || 1) * 1000;

    // 1. RICERCA CORSE (Arricchite con Classe ed Indice)
    const hash = ngeohash.encode(lat, lon, GEOHASH_PRECISION_TRATTA);
    const hashes = [hash, ...ngeohash.neighbors(hash)];
    const corsaResults = await Promise.all(hashes.map(h => redisClient.sMembers(`corsa:in_area:${h}`)));

    const corseCandidate = [...new Set(corsaResults.flat())]
        .map(id => {
            const c = CacheStore.corseCache.get(Number(id));
            if (!c) return null;
            // Arricchimento dati
            c.classe = determinaClasse(Number(c.indice_efficienza || 0));
            c.posti_totali = Number(c.posti_totali || 16); 
            return c;
        })
        .filter(Boolean);

    const { corse: corseValide } = await filterDisponibilita(
        { ...richiesta, posti_richiesti: postiRichiesti }, 
        corseCandidate, 
        []
    );
    
    const risultatiCondivise = corseValide.map(c => ({ 
        ...c, 
        tipo: c.tipo_corsa === 'condivisa' ? 'condivisa' : 'riempimento',
        is_pool: false,
        distanza: c.distanza || distanzaMetri,
        prezzo_fisso: Number(c.prezzo_fisso) || 0
    }));

    // 2. SINTESI CORSE PRIVATE (Logica invariata)
    const risultatiPrivati = [];
    for (const [veicoloId, disp] of CacheStore.veicoloToDisponibilita) {
        if (!disp.lat || !disp.lon) continue;
        const distVeicolo = turf.distance(pStart, turf.point([Number(disp.lon), Number(disp.lat)]), { units: 'kilometers' });
        if (disp.is_slot && disp.disponibile !== false && distVeicolo < 50) {
            risultatiPrivati.push({
                id: `priv_${veicoloId}`, tipo: 'privata', veicolo_id: veicoloId,
                posti_disponibili: 8, posti_totali: 8, distanza: distanzaMetri,
                is_pool: false, messaggio: "Disponibile per corsa privata"
            });
        }
    }

    // 3. LOGICA POP-BUS (Dinamica su Capacità Totale)
    const { rows: direttriciAttivate } = await pool.query(`
        SELECT d.id, d.stato, d.capacita_totale, MIN(s1.ordine_sequenziale) as min_seq, MAX(s2.ordine_sequenziale) as max_seq
        FROM direttrici_virtuali d
        JOIN segmenti s1 ON d.id = s1.direttrice_id
        JOIN segmenti s2 ON d.id = s2.direttrice_id
        WHERE d.stato IN ('in_formazione', 'in_attesa_autista', 'confermata')
        AND d.partenza_prevista BETWEEN $1::timestamptz - INTERVAL '1 hour' AND $1::timestamptz + INTERVAL '1 hour'
        GROUP BY d.id
    `, [orarioRichiesto.toISOString()]);

    const risultatiPool = (await Promise.all(direttriciAttivate.map(async (dir) => {
        const occupati = await getOccupazioneSegmenti(dir.id, dir.min_seq, dir.max_seq);
        const postiDisponibili = dir.capacita_totale - occupati;

        if (postiDisponibili >= postiRichiesti) {
            return {
                id: `pop_${dir.id}`, tipo: 'pop-bus', direttrice_id: dir.id,
                posti_disponibili: postiDisponibili, posti_totali: dir.capacita_totale,
                distanza: distanzaMetri, is_pool: true
            };
        }
        return null;
    }))).filter(Boolean);

    // 4. LOGICA MISSIONI RITORNO
    const { rows: missioniRitorno } = await pool.query(`
        SELECT mr.id, mr.direttrice_id, mr.orario_previsto, mr.segmento_id, d.capacita_totale,
               n.lat, n.lon, s.ordine_sequenziale as seq_start
        FROM missioni_ritorno mr
        JOIN direttrici_virtuali d ON mr.direttrice_id = d.id
        JOIN nodi_direttrice n ON mr.nodo_origine = n.id
        JOIN segmenti s ON mr.segmento_id = s.id
        WHERE mr.stato = 'in_attesa'
        AND mr.orario_previsto BETWEEN $1::timestamptz - INTERVAL '1 hour' AND $1::timestamptz + INTERVAL '1 hour'
    `, [orarioRichiesto.toISOString()]);

    const risultatiRitorno = (await Promise.all(missioniRitorno.map(async (mr) => {
        if (turf.distance(pStart, turf.point([mr.lon, mr.lat]), { units: 'kilometers' }) > 2.0) return null;
        
        const occupati = await getOccupazioneSegmenti(mr.direttrice_id, mr.seq_start, 999);
        const postiDisponibili = mr.capacita_totale - occupati;

        if (postiDisponibili >= postiRichiesti) {
            return {
                id: `ret_${mr.id}`, tipo: 'ritorno', missione_id: mr.id,
                direttrice_id: mr.direttrice_id, orario: mr.orario_previsto,
                posti_disponibili: postiDisponibili, posti_totali: mr.capacita_totale,
                distanza: distanzaMetri, is_pool: true, messaggio: "Corsa di ritorno disponibile"
            };
        }
        return null;
    }))).filter(Boolean);

    const risultatiFinali = [...risultatiCondivise, ...risultatiPrivati, ...risultatiPool, ...risultatiRitorno];
    
    // Proposta per nuova direttrice
    risultatiFinali.push({
        id: 'nuova_proposta', tipo: 'pop-bus', tipo_corsa: 'nuova_proposta',
        is_pool: true, messaggio: "Richiedi nuova direttrice.", is_nuova_proposta: true,
        distanza: distanzaMetri, posti_totali: 8, posti_disponibili: 8
    });

    return await formatResults({ ...richiesta, distanzaMetri }, risultatiFinali);
}