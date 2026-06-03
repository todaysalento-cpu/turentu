import * as turf from '@turf/turf';
import { v4 as uuidv4 } from 'uuid';
import { calcolaPrezzo } from '../../../utils/pricing.util.js';
import { getLocalitaSafe } from '../../../utils/maps.util.js';
import * as CacheModule from '../search.cache.js';

const localitaCache = new Map();
const SOGLIA_ATTIVAZIONE_PERCENT = 0.6; 

const safeDate = (dateInput) => {
    const d = new Date(dateInput);
    return !isNaN(d.getTime()) ? d : new Date();
};

const getSafeISO = (dateInput) => safeDate(dateInput).toISOString();

async function getLocalitaSafeCached(coord) {
    if (!coord || typeof coord.lat === 'undefined') return "N/D";
    const key = `${coord.lat.toFixed(3)}_${coord.lon.toFixed(3)}`;
    if (localitaCache.has(key)) return localitaCache.get(key);
    const loc = await getLocalitaSafe(coord);
    localitaCache.set(key, loc);
    return loc;
}

/**
 * Formatter aggiornato per gestire l'integrazione tra corse atomiche e Pool aggregato
 */
export async function formatResults(richiesta, risultatiFiltrati, corseOriginali, injectedVeicoliMap = null) {
    const [localitaOrigine, localitaDestinazione] = await Promise.all([
        getLocalitaSafeCached(richiesta.coord),
        getLocalitaSafeCached(richiesta.coordDest)
    ]);

    // 1. Separazione dei tipi di risultato
    const slots = risultatiFiltrati.filter(item => item.is_slot && item.tipo_corsa !== 'pop-bus');
    const corseStandard = risultatiFiltrati.filter(item => !item.is_slot && item.tipo_corsa !== 'pop-bus');
    const popBusPool = risultatiFiltrati.filter(item => item.tipo_corsa === 'pop-bus');

    let risultatiDaFormattare = [...slots, ...corseStandard];

    // 2. Logica Pool Dinamica
    if (popBusPool.length > 0) {
        const postiTotaliPool = popBusPool.reduce((acc, curr) => acc + Number(curr.posti_totali || 0), 0);
        // Assumiamo 0 se non abbiamo dati di prenotazione nel pool aggregato
        const postiPrenotatiPool = popBusPool.reduce((acc, curr) => acc + Number(curr.posti_prenotati || 0), 0);
        
        const postiMinimiPerAttivazione = Math.ceil(postiTotaliPool * SOGLIA_ATTIVAZIONE_PERCENT);
        const mancanti = Math.max(0, postiMinimiPerAttivazione - postiPrenotatiPool);

        risultatiDaFormattare.push({
            id: 'pool_pop_bus_' + uuidv4(),
            tipo_corsa: 'pop-bus',
            is_pool: true,
            posti_totali: postiTotaliPool,
            posti_prenotati: postiPrenotatiPool,
            mancanti: mancanti,
            messaggio: mancanti > 0 
                ? `Pop Bus in formazione: mancano ${mancanti} posti per l'attivazione.` 
                : `Pop Bus attivo! Posti disponibili.`
        });
    }

    // 3. Mappatura finale
    const formattati = await Promise.all(risultatiDaFormattare.map(async (item) => {
        try {
            if (item.is_pool) {
                return { 
                    ...item, 
                    localitaOrigine, 
                    localitaDestinazione,
                    tipo: 'pop-bus',
                    prezzo: "Variabile"
                };
            }

            const prezzo = await calcolaPrezzo(
                item, 
                richiesta.posti_richiesti, 
                item.tipo_corsa, 
                item.distanza || 0
            ).catch(() => (item.distanza || 0) * 0.45);

            return {
                id: item.id || uuidv4(),
                veicolo_id: Number(item.veicolo_id || 0),
                tipo: item.tipo_corsa || 'standard',
                localitaOrigine,
                localitaDestinazione,
                oraPartenza: getSafeISO(item.start_datetime || new Date()),
                prezzo: Number(prezzo?.toFixed(2)) || 0,
                postiDisponibili: Number((item.posti_totali || 0) - (item.posti_prenotati || 0)),
                postiTotali: Number(item.posti_totali || 0)
            };
        } catch (err) {
            console.error(`💥 Errore formattazione:`, err);
            return null;
        }
    }));

    return formattati.filter(r => r !== null);
}