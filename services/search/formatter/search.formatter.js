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
    console.log(`[DEBUG] Formattazione | Richiesta Distanza (raw): ${richiesta.distanzaMetri}m`);

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
            // LOGICA IBRIDA: Recupero distanza basato su aggancio dinamico
            // Se is_pool è true, calcoliamo la distanza reale basata su offset (STATIC o DYNAMIC)
            // Se non è disponibile un offset (nuova_proposta), usiamo la distanza stimata della richiesta
            const distMetri = item.is_pool 
                ? (item.distanza || Math.abs(Number(item.endOffset || 0) - Number(item.startOffset || 0)))
                : Number(richiesta.distanzaMetri || 0);
            
            console.log(`[DEBUG] Item ID: ${item.id} | Tipo Aggancio: ${item.aggancio ? JSON.stringify(item.aggancio) : 'N/A'} | Distanza Calcolata: ${distMetri}m`);
            
            const distKmCalc = Math.max(0.1, distMetri / 1000);
            const oraPartenza = getSafeISO(richiesta.start_datetime || Date.now());
            const oraArrivo = determinaArrivo(oraPartenza, distMetri);
            
            // 2. PRICING DINAMICO
            const p = await calcolaPrezzo(item, richiesta.posti_richiesti, item.tipo, distKmCalc)
                .catch(err => { 
                    console.error(`[ERROR] Pricing fallito per ID ${item.id}:`, err); 
                    return distKmCalc * 0.50; 
                });
            
            const prezzoVal = Number(p) || 0;
            console.log(`[DEBUG] Pricing Finale per ${item.id}: ${prezzoVal}€ (KM: ${distKmCalc.toFixed(2)})`);

            return {
                id: item.is_pool ? `dir_${item.direttrice_id}` : (item.id || `slot_${item.veicolo_id}`),
                tipo: item.tipo,
                direttrice_id: item.direttrice_id || null,
                // Includiamo info sull'aggancio per il frontend (opzionale)
                aggancio_info: item.aggancio || null, 
                localitaOrigine,
                localitaDestinazione,
                oraPartenza,
                oraArrivo,
                prezzo: prezzoVal,
                prezzo_display: Math.ceil(prezzoVal).toString(),
                postiDisponibili: item.posti_disponibili,
                postiTotali: Number(item.posti_totali || 8),
                is_pool: !!item.is_pool,
                is_nuova_proposta: item.tipo_corsa === 'nuova_proposta',
                messaggio: item.messaggio,
                marca: item.marca || null,
                modello: item.modello || null,
                servizi: parseServizi(item.servizi)
            };
        } catch (err) {
            console.error(`💥 Errore critico formattazione ID ${item.id}:`, err);
            return null;
        }
    }))).filter(r => r !== null);
}