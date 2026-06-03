import { v4 as uuidv4 } from 'uuid';
import { calcolaPrezzo } from '../../../utils/pricing.util.js';
import { getLocalitaSafe } from '../../../utils/maps.util.js';

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
 * Formatter per gestire l'integrazione tra corse atomiche e Pool aggregato
 */
export async function formatResults(richiesta, risultatiFiltrati, corseOriginali) {
    const [localitaOrigine, localitaDestinazione] = await Promise.all([
        getLocalitaSafeCached(richiesta.coord),
        getLocalitaSafeCached(richiesta.coordDest)
    ]);

    // 1. Separazione tramite flag di pool (più pulito della stringa tipo_corsa)
    const popBusPool = risultatiFiltrati.filter(item => item.is_pool);
    const altriRisultati = risultatiFiltrati.filter(item => !item.is_pool);

    let risultatiDaFormattare = [...altriRisultati];

    // 2. Logica Pool Aggregata
    if (popBusPool.length > 0) {
        const postiTotaliPool = popBusPool.reduce((acc, curr) => acc + Number(curr.posti_totali || 0), 0);
        // Assicurati che i dati in ingresso abbiano posti_prenotati (default a 0)
        const postiPrenotatiPool = popBusPool.reduce((acc, curr) => acc + Number(curr.posti_prenotati || 0), 0);
        
        const postiMinimiPerAttivazione = Math.ceil(postiTotaliPool * SOGLIA_ATTIVAZIONE_PERCENT);
        const mancanti = Math.max(0, postiMinimiPerAttivazione - postiPrenotatiPool);

        risultatiDaFormattare.push({
            id: 'pool_pop_bus_fixed_id', // ID costante per stabilità UI
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
    return (await Promise.all(risultatiDaFormattare.map(async (item) => {
        try {
            if (item.is_pool) {
                return { 
                    ...item, 
                    tipo: 'pop-bus',
                    localitaOrigine, 
                    localitaDestinazione,
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
                id: item.id,
                veicolo_id: Number(item.veicolo_id || 0),
                tipo: item.tipo_corsa || 'standard',
                localitaOrigine,
                localitaDestinazione,
                oraPartenza: getSafeISO(item.start_datetime || new Date()),
                prezzo: Number(prezzo?.toFixed(2)) || 0,
                postiDisponibili: Math.max(0, Number(item.posti_totali || 0) - Number(item.posti_prenotati || 0)),
                postiTotali: Number(item.posti_totali || 0)
            };
        } catch (err) {
            console.error(`💥 Errore formattazione risultato:`, err);
            return null;
        }
    }))).filter(r => r !== null);
}