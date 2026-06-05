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

/**
 * Normalizza i servizi per garantire compatibilità tra Array (db) e Oggetto (frontend)
 */
const normalizzaServizi = (servizi) => {
    if (Array.isArray(servizi)) {
        return servizi.reduce((acc, s) => ({ ...acc, [s]: true }), {});
    }
    return servizi || {};
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
 * Formatter aggiornato: gestisce la normalizzazione dei servizi e la distanza reale
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
            messaggio: mancanti > 0 ? `Pop Bus in formazione: mancano ${mancanti} posti.` : `Pop Bus attivo!`
        });
    }

    const distTrattaMetri = Number(richiesta.distanzaMetri || 10000);
    const distKm = distTrattaMetri / 1000;

    return (await Promise.all(risultatiDaFormattare.map(async (item) => {
        try {
            const veicoloInfo = {
                marca: item.marca || 'N/D',
                modello: item.modello || 'N/D',
                rating: Number(item.rating || 0),
                servizi: normalizzaServizi(item.servizi)
            };

            // A. Caso Pool
            if (item.is_pool) {
                // Calcoliamo il prezzo con la nuova logica specifica per pop-bus
                const p = await calcolaPrezzo(item, richiesta.posti_richiesti, 'pop-bus', distKm, distKm);
                const prezzoVal = Number(p) || 0;
                
                return { 
                    ...item, 
                    localitaOrigine, 
                    localitaDestinazione, 
                    prezzo: prezzoVal, 
                    prezzo_display: prezzoVal.toFixed(0) 
                };
            }

            // B. Caso Slot Privato
            if (item.tipo === 'privata_slot') {
                const p = await calcolaPrezzo(item, richiesta.posti_richiesti, 'privata', distKm, distKm)
                    .catch(() => distKm * 0.5);

                const prezzoVal = Number(p) || 0;
                return {
                    id: `slot_privato_${item.veicolo_id}`,
                    veicolo_id: Number(item.veicolo_id),
                    tipo: 'privata',
                    ...veicoloInfo,
                    localitaOrigine,
                    localitaDestinazione,
                    oraPartenza: getSafeISO(richiesta.start_datetime),
                    prezzo: prezzoVal, 
                    prezzo_display: prezzoVal.toFixed(0), 
                    postiDisponibili: Number(item.posti_totali || 0),
                    postiTotali: Number(item.posti_totali || 0),
                    is_privato: true
                };
            }

            // C. Caso Corsa Condivisa
            const distItemKm = (item.distanza || distTrattaMetri) / 1000;
            const p = await calcolaPrezzo(item, richiesta.posti_richiesti, item.tipo_corsa, distItemKm, distItemKm)
                .catch(() => distItemKm * 0.45);
            
            const prezzoVal = Number(p) || 0;

            return {
                id: item.id,
                veicolo_id: Number(item.veicolo_id || 0),
                tipo: item.tipo_corsa || 'standard',
                ...veicoloInfo,
                localitaOrigine,
                localitaDestinazione,
                oraPartenza: getSafeISO(item.start_datetime || new Date()),
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