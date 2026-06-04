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

// Funzione helper per calcolare l'orario di arrivo
const calcolaArrivo = (partenzaISO, durataMinuti) => {
    const d = new Date(partenzaISO);
    d.setMinutes(d.getMinutes() + (Number(durataMinuti) || 0));
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

/**
 * Formatter aggiornato: gestisce Pool, Slot Privati e Corse Condivise
 * con calcolo sicuro di prezzo e orario di arrivo.
 */
export async function formatResults(richiesta, risultatiFiltrati, corseOriginali) {
    const [localitaOrigine, localitaDestinazione] = await Promise.all([
        getLocalitaSafeCached(richiesta.coord),
        getLocalitaSafeCached(richiesta.coordDest)
    ]);

    const popBusPool = risultatiFiltrati.filter(item => item.is_pool);
    const slotPrivati = risultatiFiltrati.filter(item => item.tipo === 'privata_slot');
    const corseCondivise = risultatiFiltrati.filter(item => !item.is_pool && item.tipo !== 'privata_slot');

    let risultatiDaFormattare = [...corseCondivise, ...slotPrivati];

    if (popBusPool.length > 0) {
        const postiTotaliPool = popBusPool.reduce((acc, curr) => acc + Number(curr.posti_totali || 0), 0);
        const postiPrenotatiPool = popBusPool.reduce((acc, curr) => acc + Number(curr.posti_prenotati || 0), 0);
        const postiMinimiPerAttivazione = Math.ceil(postiTotaliPool * SOGLIA_ATTIVAZIONE_PERCENT);
        const mancanti = Math.max(0, postiMinimiPerAttivazione - postiPrenotatiPool);

        risultatiDaFormattare.push({
            id: 'pool_pop_bus_fixed_id',
            is_pool: true,
            tipo: 'pop-bus',
            posti_totali: postiTotaliPool,
            posti_prenotati: postiPrenotatiPool,
            mancanti: mancanti,
            messaggio: mancanti > 0 ? `Mancano ${mancanti} posti.` : `Pop Bus attivo!`
        });
    }

    return (await Promise.all(risultatiDaFormattare.map(async (item) => {
        try {
            // A. Caso Pool
            if (item.is_pool) {
                return { 
                    ...item, 
                    localitaOrigine, 
                    localitaDestinazione,
                    prezzo: 0, 
                    prezzo_display: "Variabile"
                };
            }

            // B. Caso Slot Privato
            if (item.tipo === 'privata_slot') {
                const oraPartenza = getSafeISO(richiesta.start_datetime);
                return {
                    id: `slot_privato_${item.veicolo_id}`,
                    veicolo_id: Number(item.veicolo_id),
                    tipo: 'privata',
                    modello: item.modello,
                    localitaOrigine,
                    localitaDestinazione,
                    oraPartenza,
                    oraArrivo: calcolaArrivo(oraPartenza, item.durata_minuti || 60),
                    prezzo: 0, 
                    prezzo_display: "Su richiesta",
                    postiDisponibili: Number(item.posti_totali || 0),
                    postiTotali: Number(item.posti_totali || 0),
                    is_privato: true
                };
            }

            // C. Caso Corsa Condivisa
            const p = await calcolaPrezzo(item, richiesta.posti_richiesti, item.tipo_corsa, item.distanza || 0)
                .catch(() => (item.distanza || 0) * 0.45);
            
            const prezzoVal = Number(p) || 0;
            const oraPartenza = getSafeISO(item.start_datetime || new Date());

            return {
                id: item.id,
                veicolo_id: Number(item.veicolo_id || 0),
                tipo: item.tipo_corsa || 'standard',
                localitaOrigine,
                localitaDestinazione,
                oraPartenza,
                oraArrivo: calcolaArrivo(oraPartenza, item.durata_minuti || 60),
                prezzo: prezzoVal, 
                prezzo_display: prezzoVal.toFixed(0), 
                postiDisponibili: Math.max(0, Number(item.posti_totali || 0) - Number(item.posti_prenotati || 0)),
                postiTotali: Number(item.posti_totali || 0)
            };
        } catch (err) {
            console.error(`💥 Errore formattazione risultato:`, err);
            return null;
        }
    }))).filter(r => r !== null);
}