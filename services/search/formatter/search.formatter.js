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

/**
 * Calcola l'orario di arrivo basato sulla distanza reale (offset)
 */
const determinaArrivo = (partenzaISO, distanzaMetri) => {
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

export async function formatResults(richiesta, risultatiFiltrati) {
    console.log(`[DEBUG] Formattazione Pop-Bus Aware | Risultati: ${risultatiFiltrati.length}`);

    const [localitaOrigine, localitaDestinazione] = await Promise.all([
        (typeof richiesta.localitaOrigine === 'string' && richiesta.localitaOrigine !== "N/D") 
            ? richiesta.localitaOrigine 
            : getLocalitaSafeCached(richiesta.coord),
        (typeof richiesta.localitaDestinazione === 'string' && richiesta.localitaDestinazione !== "N/D") 
            ? richiesta.localitaDestinazione 
            : getLocalitaSafeCached(richiesta.coordDest)
    ]);

    return (await Promise.all(risultatiFiltrati.map(async (item) => {
        try {
            // 1. LOGICA DISTANZA: Gli item POOL usano gli offset, gli altri la distanza euclidea della richiesta
            const distMetri = item.is_pool 
                ? Math.abs(Number(item.endOffset || 0) - Number(item.startOffset || 0)) 
                : Number(richiesta.distanzaMetri || 10000);
            
            const distKmCalc = Math.max(0.1, distMetri / 1000);
            const oraPartenza = getSafeISO(richiesta.start_datetime || Date.now());
            const oraArrivo = determinaArrivo(oraPartenza, distMetri);
            
            // 2. PRICING: Passaggio dell'intero oggetto item per permettere pricing basato su 'direttrice_id'
            const p = await calcolaPrezzo(item, richiesta.posti_richiesti, item.tipo, distKmCalc)
                .catch(err => { 
                    console.error(`[ERROR] Pricing fallito per ${item.id}:`, err); 
                    return distKmCalc * 0.45; 
                });
            
            const prezzoVal = Number(p) || 0;

            // 3. COSTRUZIONE OGGETTO RISULTATO
            return {
                id: item.is_pool ? `dir_${item.direttrice_id}` : (item.id || `slot_${item.veicolo_id}`),
                tipo: item.tipo, // 'pop-bus', 'condivisa', 'privata_slot'
                direttrice_id: item.direttrice_id || null,
                veicolo_id: Number(item.veicolo_id || 0),
                localitaOrigine,
                localitaDestinazione,
                oraPartenza,
                oraArrivo,
                prezzo: prezzoVal,
                prezzo_display: Math.ceil(prezzoVal).toString(),
                
                // Gestione specifica Pop-Bus
                postiDisponibili: item.posti_disponibili,
                postiTotali: Number(item.posti_totali || 0),
                is_pool: !!item.is_pool,
                is_nuova_proposta: item.tipo_corsa === 'nuova_proposta',
                
                messaggio: item.messaggio || (item.is_pool ? "Servizio condiviso" : "Corsa disponibile"),
                marca: item.marca || null,
                modello: item.modello || null,
                servizi: parseServizi(item.servizi)
            };
        } catch (err) {
            console.error(`💥 Errore formattazione ID ${item.id}:`, err);
            return null;
        }
    }))).filter(r => r !== null);
}