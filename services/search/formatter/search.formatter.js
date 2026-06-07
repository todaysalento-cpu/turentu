import { calcolaPrezzo } from '../../../utils/pricing.util.js';
import { getLocalitaSafe } from '../../../utils/maps.util.js';

const localitaCache = new Map();
const VELOCITA_MEDIA_KM_MIN = 1.0; 

const safeDate = (dateInput) => {
    const d = new Date(dateInput);
    return !isNaN(d.getTime()) ? d : new Date();
};

const getSafeISO = (dateInput) => safeDate(dateInput).toISOString();

const parseServizi = (servizi) => {
    if (!servizi) return {};
    if (typeof servizi === 'object') return servizi;
    try { return JSON.parse(servizi); } catch (e) { return {}; }
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

export async function formatResults(richiesta, risultatiFiltrati, corseOriginali) {
    console.log(`[DEBUG] Inizio formattazione. Risultati totali: ${risultatiFiltrati.length}`);

    const [localitaOrigine, localitaDestinazione] = await Promise.all([
        (typeof richiesta.localitaOrigine === 'string' && richiesta.localitaOrigine !== "N/D") ? richiesta.localitaOrigine : getLocalitaSafeCached(richiesta.coord),
        (typeof richiesta.localitaDestinazione === 'string' && richiesta.localitaDestinazione !== "N/D") ? richiesta.localitaDestinazione : getLocalitaSafeCached(richiesta.coordDest)
    ]);

    const distanzaRealeMetri = Number(richiesta.distanzaMetri || 10000);

    // Mappatura pulita dei risultati
    let risultatiDaFormattare = risultatiFiltrati.map(item => {
        // Se è un elemento pool, lo passiamo intatto (è già stato validato nel service)
        if (item.is_pool) return item;
        return item;
    });

    return (await Promise.all(risultatiDaFormattare.map(async (item) => {
        try {
            const distMetri = Number(item.distMetri || item.distanza || distanzaRealeMetri);
            const distKmCalc = Math.max(0.1, distMetri / 1000);
            const oraPartenza = getSafeISO(item.start_datetime || richiesta.start_datetime);
            const oraArrivo = determinaArrivo(oraPartenza, item.arrivo_datetime, distMetri);
            const tipoCalcolo = item.tipo === 'privata_slot' ? 'privata' : (item.tipo_corsa || item.tipo || 'standard');
            
            // Chiamata al pricing
            const p = await calcolaPrezzo(item, richiesta.posti_richiesti, tipoCalcolo, distKmCalc, distKmCalc)
                .catch(err => { 
                    console.error(`[ERROR] Pricing fallito per ${item.id}:`, err); 
                    return distKmCalc * 0.45; 
                });
            
            const prezzoVal = Number(p) || 0;

            return {
                id: item.id || `slot_privato_${item.veicolo_id}`,
                veicolo_id: Number(item.veicolo_id || 0),
                tipo: tipoCalcolo,
                localitaOrigine, 
                localitaDestinazione,
                origine: item.origine || richiesta.coord,
                destinazione: item.destinazione || richiesta.coordDest,
                oraPartenza, 
                oraArrivo,
                marca: item.is_pool ? null : (item.marca || 'N/D'),
                modello: item.is_pool ? null : (item.modello || 'N/D'),
                rating: Number(item.rating || 0),
                servizi: parseServizi(item.servizi),
                prezzo: prezzoVal,
                prezzo_display: prezzoVal.toFixed(0),
                postiDisponibili: Math.max(0, Number(item.posti_totali || 0) - Number(item.posti_prenotati || 0)),
                postiTotali: Number(item.posti_totali || 0),
                is_privato: item.tipo === 'privata_slot',
                is_pool: !!item.is_pool,
                veicoli_pool_ids: item.veicoli_pool_ids || [], // Propaga la lista validata dal Service
                messaggio: item.messaggio
            };
        } catch (err) {
            console.error(`💥 Errore formattazione ID ${item.id}:`, err);
            return null;
        }
    }))).filter(r => r !== null);
}