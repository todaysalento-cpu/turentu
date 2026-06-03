import * as turf from '@turf/turf';
import { v4 as uuidv4 } from 'uuid';
import { calcolaPrezzo } from '../../../utils/pricing.util.js';
import { getLocalitaSafe, getDurataDistanza } from '../../../utils/maps.util.js';
import * as CacheModule from '../search.cache.js';

const localitaCache = new Map();
const SOGLIA_ATTIVAZIONE_PERCENT = 0.6; // 60% dei posti totali per attivare

/**
 * Utility per gestire date potenzialmente corrotte dal DB
 */
const safeDate = (dateInput) => {
    const d = new Date(dateInput);
    return !isNaN(d.getTime()) ? d : new Date();
};

const getSafeISO = (dateInput) => safeDate(dateInput).toISOString();

const calcolaArrivo = (startISO, durataMinuti = 20) => {
    const d = safeDate(startISO);
    d.setMinutes(d.getMinutes() + (durataMinuti || 20));
    return d.toISOString();
};

async function getLocalitaSafeCached(coord) {
    if (!coord || typeof coord.lat === 'undefined') return "N/D";
    const key = `${coord.lat.toFixed(3)}_${coord.lon.toFixed(3)}`;
    if (localitaCache.has(key)) return localitaCache.get(key);
    const loc = await getLocalitaSafe(coord);
    localitaCache.set(key, loc);
    return loc;
}

export async function formatResults(richiesta, risultatiFiltrati, corseOriginali, injectedVeicoliMap = null) {
    const veicoliMap = injectedVeicoliMap || CacheModule.CacheStore.veicoliCache;

    const [localitaOrigine, localitaDestinazione] = await Promise.all([
        getLocalitaSafeCached(richiesta.coord),
        getLocalitaSafeCached(richiesta.coordDest)
    ]);

    const slots = risultatiFiltrati.filter(item => item.is_slot);
    const corseStandard = risultatiFiltrati.filter(item => !item.is_slot && !(item.tipo_corsa === 'riempimento' && item.stato === 'da_attivare'));
    const riempimentiInAttesa = risultatiFiltrati.filter(item => !item.is_slot && item.tipo_corsa === 'riempimento' && item.stato === 'da_attivare');

    let risultatiDaFormattare = [...slots, ...corseStandard];

    // Logica Pool Dinamica
    if (riempimentiInAttesa.length > 0) {
        const poolId = 'pool_' + uuidv4();
        
        const datiPool = await Promise.all(riempimentiInAttesa.map(async (r) => {
            const totali = Number(r.posti_totali || 1);
            const attuali = Number(r.posti_prenotati || 0);
            
            const postiMinimi = Math.ceil(totali * SOGLIA_ATTIVAZIONE_PERCENT);
            const mancanti = Math.max(0, postiMinimi - attuali);

            let pMax = 0;
            try {
                pMax = await calcolaPrezzo(r, richiesta.posti_richiesti, 'riempimento', 0, r.distanza || 0);
            } catch (e) { pMax = (r.distanza || 0) * 0.5; }

            const pMin = (Number(r.euro_km || 1.0) * (r.distanza || 0) / totali) * richiesta.posti_richiesti;
            
            return { pMin, pMax, mancanti };
        }));

        const prezziMin = datiPool.map(p => p.pMin);
        const prezziMax = datiPool.map(p => p.pMax);
        const totaleMancanti = datiPool.reduce((acc, curr) => acc + curr.mancanti, 0);
        
        risultatiDaFormattare.push({
            id: poolId,
            tipo: 'riempimento_pool',
            corse_ids: riempimentiInAttesa.map(r => r.id),
            rangePrezzo: {
                min: Math.max(0.50, Math.min(...prezziMin)).toFixed(2),
                max: Math.max(0.50, Math.max(...prezziMax)).toFixed(2)
            },
            postiMancanti: totaleMancanti,
            is_pool: true
        });
    }

    // Mappatura finale con gestione robusta errori
    const formattati = await Promise.all(risultatiDaFormattare.map(async (item) => {
        try {
            if (item.is_pool) {
                return { 
                    ...item, 
                    localitaOrigine, 
                    localitaDestinazione, 
                    messaggio: `Corse in attesa: mancano ${item.postiMancanti} posti per l'attivazione.` 
                };
            }

            // GESTIONE CORSE / SLOT
            const isSlot = !!item.is_slot;
            let prezzo = 0;
            
            try {
                const dist = item.distanza || 0;
                prezzo = await calcolaPrezzo(item, richiesta.posti_richiesti, item.tipo_corsa, dist, dist, item.posti_prenotati);
            } catch (err) {
                console.warn(`⚠️ Tariffa non trovata per ${item.id}, fallback applicato.`);
                prezzo = (item.distanza || 0) * 0.45;
            }

            return {
                id: item.id || uuidv4(),
                veicolo_id: Number(item.veicolo_id),
                marca: item.marca || "Veicolo",
                modello: item.modello || "",
                tipo: item.tipo_corsa || 'standard',
                badge: item.tipo_corsa?.toUpperCase() || 'STANDARD',
                localitaOrigine,
                localitaDestinazione,
                oraPartenza: getSafeISO(item.start_datetime),
                oraArrivo: item.arrivo_datetime ? getSafeISO(item.arrivo_datetime) : calcolaArrivo(item.start_datetime, 20),
                prezzo: Number(prezzo?.toFixed(2)) || 0,
                postiDisponibili: Number(item.posti_disponibili ?? item.postiDisponibili ?? 0),
                postiTotali: Number(item.posti_totali ?? 0),
                postiPrenotati: Number(item.posti_prenotati ?? 0),
                percorsoVisualizzato: null 
            };

        } catch (err) {
            console.error(`💥 Errore critico formattazione ${item?.id}:`, err);
            return null;
        }
    }));

    return formattati.filter(r => r !== null);
}