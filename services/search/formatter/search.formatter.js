import { calcolaPrezzo } from '../../../utils/pricing.util.js';
import { getLocalitaSafe } from '../../../utils/maps.util.js';
import { CacheStore } from './search.cache.js'; // IMPORT AGGIUNTO

const localitaCache = new Map();
const VELOCITA_MEDIA_KM_MIN = 1.0; 

const UI_CONFIG = {
    'pop-bus': { colore: '#FF9800' }, 
    'popbus': { colore: '#FF9800' },  
    'privata': { colore: '#000000' },  
    'condivisa': { colore: '#4A90E2' } 
};

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
    console.log(`🚀 [FORMAT] Inizio elaborazione di ${risultatiFiltrati?.length || 0} risultati.`);

    const buckets = { condivisa: [], privata: [], 'pop-bus': [] };
    risultatiFiltrati.forEach(item => {
        if (buckets[item.tipo]) buckets[item.tipo].push(item);
    });

    const risultatiLimitati = [
        ...buckets.condivisa.slice(0, 4),
        ...buckets.privata.slice(0, 4),
        ...buckets['pop-bus'].slice(0, 4)
    ].slice(0, 12);

    const [localitaOrigine, localitaDestinazione] = await Promise.all([
        (typeof richiesta.localitaOrigine === 'string' && richiesta.localitaOrigine !== "N/D") 
            ? richiesta.localitaOrigine : getLocalitaSafeCached(richiesta.coord),
        (typeof richiesta.localitaDestinazione === 'string' && richiesta.localitaDestinazione !== "N/D") 
            ? richiesta.localitaDestinazione : getLocalitaSafeCached(richiesta.coordDest)
    ]);

    const distMetriRichiesta = Number(richiesta.distanzaMetri || 1000);
    const distKmRichiesta = distMetriRichiesta / 1000;

    const results = await Promise.all(risultatiLimitati.map(async (item) => {
        try {
            console.log(`🔎 [FORMAT] Elaborando ID: ${item.id} | Tipo: ${item.tipo}`);

            if (item.id === 'virtual_pop_pending') {
                // PATCH: Garantiamo il popolamento del pool
                if (!item.veicoli_pool_ids || item.veicoli_pool_ids.length === 0) {
                    item.veicoli_pool_ids = Array.from(CacheStore.veicoloToDisponibilita.keys());
                    console.log(`🚌 [FORMAT] Pool iniettato da CacheStore. Totale: ${item.veicoli_pool_ids.length}`);
                }
                
                const p = await calcolaPrezzo(
                    item, 
                    richiesta.posti_richiesti || 1,
                    'pop-bus',
                    distKmRichiesta,
                    distKmRichiesta,
                    0,
                    richiesta.classe || 'STANDARD'
                );
                
                return {
                    id: item.id,
                    tipo: item.tipo,
                    colore_ui: UI_CONFIG[item.tipo]?.colore || '#9E9E9E',
                    classe: richiesta.classe || 'STANDARD',
                    localitaOrigine,
                    localitaDestinazione,
                    oraPartenza: getSafeISO(richiesta.start_datetime || Date.now()),
                    oraArrivo: 'N/D',
                    prezzo: Number(p) || 0,
                    prezzo_display: `~ ${Math.ceil(Number(p) || 0)}€`,
                    postiDisponibili: 0,
                    postiTotali: 0,
                    is_pool: true,
                    veicoli_pool_ids: item.veicoli_pool_ids,
                    messaggio: item.messaggio || "Ottimizzazione in corso...",
                    servizi: {}
                };
            }

            // --- FLUSSO STANDARD ---
            let distMetri = item.is_pool ? (item.distanza || 1000) : distMetriRichiesta;
            const distKmCalc = distMetri / 1000;
            const distKmTotali = item.distanzaTotaleRotte || distKmCalc; 
            
            const p = await calcolaPrezzo(item, richiesta.posti_richiesti || 1, item.tipo, distKmCalc, distKmTotali, 0, item.classe)
                .catch(err => { console.error(`❌ [FORMAT] Errore calcolaPrezzo ${item.id}:`, err); return distKmCalc * 0.5; });
            
            const prezzoVal = Number(p) || 0;

            return {
                id: item.id || `slot_${item.veicolo_id}`,
                veicolo_id: item.veicolo_id || null,
                tipo: item.tipo,
                colore_ui: UI_CONFIG[item.tipo]?.colore || '#9E9E9E',
                classe: item.classe || 'STANDARD',
                localitaOrigine,
                localitaDestinazione,
                oraPartenza: getSafeISO(richiesta.start_datetime || Date.now()),
                oraArrivo: determinaArrivo(getSafeISO(richiesta.start_datetime || Date.now()), distMetri),
                prezzo: prezzoVal,
                prezzo_display: Math.ceil(prezzoVal).toString(),
                postiDisponibili: item.posti_disponibili || 0,
                postiTotali: Number(item.posti_totali || 8),
                is_pool: !!item.is_pool,
                messaggio: item.messaggio || null,
                servizi: parseServizi(item.servizi)
            };
        } catch (err) {
            console.error(`💥 [FORMAT] Errore critico ID ${item.id}:`, err);
            return null;
        }
    }));

    const output = results.filter(r => r !== null);
    console.log(`🏁 [FORMAT] Operazione conclusa. Elementi validi restituiti: ${output.length}`);
    return output;
}