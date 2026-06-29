import { calcolaPrezzo } from '../../../utils/pricing.util.js';
import { getLocalitaSafe } from '../../../utils/maps.util.js';

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
    
    // Logica bucket tollerante
    risultatiFiltrati.forEach(item => {
        const tipoKey = String(item.tipo || 'condivisa').toLowerCase().trim();
        if (tipoKey === 'condivisa') buckets.condivisa.push(item);
        else if (tipoKey === 'privata') buckets.privata.push(item);
        else if (tipoKey === 'pop-bus' || tipoKey === 'popbus') buckets['pop-bus'].push(item);
        else buckets.condivisa.push(item); // Default fallback
    });

    const risultatiLimitati = [
        ...buckets.condivisa.slice(0, 4),
        ...buckets.privata.slice(0, 4),
        ...buckets['pop-bus'].slice(0, 4)
    ].slice(0, 12);

    console.log(`📦 [FORMAT] Elementi dopo bucket e slice: ${risultatiLimitati.length}`);

    const [localitaOrigine, localitaDestinazione] = await Promise.all([
        (typeof richiesta.localitaOrigine === 'string' && richiesta.localitaOrigine !== "N/D") 
            ? richiesta.localitaOrigine 
            : getLocalitaSafeCached(richiesta.coord),
        (typeof richiesta.localitaDestinazione === 'string' && richiesta.localitaDestinazione !== "N/D") 
            ? richiesta.localitaDestinazione 
            : getLocalitaSafeCached(richiesta.coordDest)
    ]);

    const distMetriRichiesta = Number(richiesta.distanzaMetri || 1000);
    const distKmRichiesta = distMetriRichiesta / 1000;

    const results = await Promise.all(risultatiLimitati.map(async (item) => {
        try {
            // Protezione ID e log
            const itemId = String(item.id ?? '');
            console.log(`🔎 [FORMAT] Elaborando ID: ${itemId} | Tipo: ${item.tipo}`);

            // 1. PROPOSTE VIRTUALI
            if (itemId.startsWith('virtual_pop_')) {
                const poolSicuro = (item.veicoli_pool_ids && item.veicoli_pool_ids.length > 0) ? item.veicoli_pool_ids : [];
                
                const p = await calcolaPrezzo(
                    { ...item, veicoli_pool_ids: poolSicuro }, 
                    richiesta.posti_richiesti || 1,
                    'pop-bus',
                    distKmRichiesta,
                    distKmRichiesta,
                    0,
                    item.classe || 'STANDARD'
                );
                
                const prezzoVal = Number(p) || 0;

                return {
                    id: itemId,
                    tipo: 'pop-bus',
                    colore_ui: '#FF9800',
                    classe: item.classe || 'STANDARD',
                    localitaOrigine,
                    localitaDestinazione,
                    oraPartenza: getSafeISO(richiesta.start_datetime || Date.now()),
                    oraArrivo: 'N/D',
                    prezzo: prezzoVal,
                    prezzo_display: `~ ${Math.ceil(prezzoVal)}€`,
                    postiDisponibili: 0,
                    postiTotali: 0,
                    is_pool: true,
                    veicoli_pool_ids: poolSicuro,
                    messaggio: item.messaggio || "Ottimizzazione in corso...",
                    servizi: {}
                };
            }

            // 2. CORSE REALI
            let distMetri = item.is_pool 
                ? (item.distanza || Math.abs(Number(item.endOffset || 0) - Number(item.startOffset || 0)))
                : distMetriRichiesta;
            
            if (!distMetri || isNaN(distMetri) || distMetri <= 0) distMetri = 1000;
            
            const distKmCalc = distMetri / 1000;
            const distKmTotali = item.distanzaTotaleRotte || distKmCalc; 
            const oraPartenza = getSafeISO(richiesta.start_datetime || Date.now());
            const oraArrivo = determinaArrivo(oraPartenza, distMetri);
            
            const p = await calcolaPrezzo(
                item, 
                richiesta.posti_richiesti || 1, 
                item.tipo, 
                distKmCalc, 
                distKmTotali, 
                0,
                item.classe 
            ).catch(() => distKmCalc * 0.50);
            
            const prezzoVal = Number(p) || 0;

            return {
                id: item.is_pool ? (item.missione_id ? `ret_${item.missione_id}` : `dir_${item.direttrice_id}`) : (itemId || `slot_${item.veicolo_id}`),
                veicolo_id: item.veicolo_id || null,
                tipo: item.tipo,
                colore_ui: UI_CONFIG[item.tipo]?.colore || '#9E9E9E',
                classe: item.classe || 'STANDARD',
                localitaOrigine,
                localitaDestinazione,
                oraPartenza,
                oraArrivo,
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
    console.log(`🏁 [FORMAT] Operazione conclusa. Elementi validi: ${output.length}`);
    return output;
}