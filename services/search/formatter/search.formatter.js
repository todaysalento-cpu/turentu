import { v4 as uuidv4 } from 'uuid';
import { calcolaPrezzo } from '../../../utils/pricing.util.js';
import { getLocalitaSafe } from '../../../utils/maps.util.js';

const localitaCache = new Map();
const SOGLIA_ATTIVAZIONE_PERCENT = 0.6; 
const VELOCITA_MEDIA_KM_MIN = 1.0; 

const safeDate = (dateInput) => {
    const d = new Date(dateInput);
    return !isNaN(d.getTime()) ? d : new Date();
};

const getSafeISO = (dateInput) => safeDate(dateInput).toISOString();

// Helper per parsare i servizi in modo sicuro
const parseServizi = (servizi) => {
    if (!servizi) return {};
    if (typeof servizi === 'object') return servizi;
    try {
        return JSON.parse(servizi);
    } catch (e) {
        return {};
    }
};

const determinaArrivo = (partenzaISO, arrivoDB, distanzaMetri) => {
    if (arrivoDB) return getSafeISO(arrivoDB);
    const distanzaKm = (Number(distanzaMetri) || 0) / 1000;
    const durataMinuti = Math.max(30, Math.round(distanzaKm / VELOCITA_MEDIA_KM_MIN));
    const d = new Date(partenzaISO);
    d.setMinutes(d.getMinutes() + durataMinuti);
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
 * @param {Object} richiesta - Contesto della richiesta
 * @param {Array} risultatiFiltrati - Lista corse/slot
 * @param {Array} corseOriginali
 */
export async function formatResults(richiesta, risultatiFiltrati, corseOriginali) {
    const getValoreLocalita = async (val, coord) => {
        if (typeof val === 'string' && val !== "N/D" && val !== "Località sconosciuta") return val;
        if (val?.description && val.description !== "N/D") return val.description;
        return await getLocalitaSafeCached(coord);
    };

    const [localitaOrigine, localitaDestinazione] = await Promise.all([
        getValoreLocalita(richiesta.localitaOrigine, richiesta.coord),
        getValoreLocalita(richiesta.localitaDestinazione, richiesta.coordDest)
    ]);

    const distanzaRealeMetri = Number(richiesta.distanzaMetri || 10000);

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
            id: 'pool_pop_bus_fixed_id', is_pool: true, tipo: 'pop-bus',
            posti_totali: postiTotaliPool, posti_prenotati: postiPrenotatiPool, mancanti: mancanti,
            messaggio: mancanti > 0 ? `Mancano ${mancanti} posti.` : `Pop Bus attivo!`,
            localitaOrigine, localitaDestinazione
        });
    }

    return (await Promise.all(risultatiDaFormattare.map(async (item) => {
        try {
            if (item.is_pool) return { 
                ...item, 
                localitaOrigine, 
                localitaDestinazione, 
                prezzo: 0, 
                prezzo_display: "Variabile",
                servizi: {} 
            };

            const distMetri = Number(item.distanza || distanzaRealeMetri);
            const distKm = Math.max(0.1, distMetri / 1000);

            const oraPartenza = getSafeISO(item.start_datetime || richiesta.start_datetime);
            const oraArrivo = determinaArrivo(oraPartenza, item.arrivo_datetime, distMetri);

            const tipoCalcolo = item.tipo === 'privata_slot' ? 'privata' : (item.tipo_corsa || 'standard');
            
            const p = await calcolaPrezzo(item, richiesta.posti_richiesti, tipoCalcolo, distKm, distKm)
                .catch(() => distKm * 0.45);
            
            const prezzoVal = Number(p) || 0;

            return {
                id: item.id || `slot_privato_${item.veicolo_id}`,
                veicolo_id: Number(item.veicolo_id || 0),
                tipo: tipoCalcolo,
                localitaOrigine, 
                localitaDestinazione, 
                oraPartenza, 
                oraArrivo,
                marca: item.marca || 'N/D', 
                modello: item.modello || 'N/D',
                rating: Number(item.rating || 0), 
                // 🟢 Gestione corretta dei servizi
                servizi: parseServizi(item.servizi), 
                prezzo: prezzoVal, 
                prezzo_display: prezzoVal.toFixed(0),
                postiDisponibili: Math.max(0, Number(item.posti_totali || 0) - Number(item.posti_prenotati || 0)),
                postiTotali: Number(item.posti_totali || 0),
                is_privato: item.tipo === 'privata_slot'
            };
        } catch (err) {
            console.error(`💥 Errore formattazione:`, err);
            return null;
        }
    }))).filter(r => r !== null);
}