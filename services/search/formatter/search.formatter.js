import { calcolaPrezzo } from '../../../utils/pricing.util.js';
import { getLocalitaSafe } from '../../../utils/maps.util.js';

const localitaCache = new Map();
const VELOCITA_MEDIA_KM_MIN = 1.0; 

// Configurazione UI centralizzata
const UI_CONFIG = {
    'pop-bus': { colore: '#FF9800' },
    'popbus': { colore: '#FF9800' },
    'privata': { colore: '#4A90E2' },
    'condivisa': { colore: '#673AB7' }
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
    console.log(`[DEBUG] Formattazione | Richiesta Distanza (raw): ${richiesta.distanzaMetri}m`);

    // 1. ORGANIZZAZIONE BUCKET
    const buckets = { condivisa: [], privata: [], 'pop-bus': [] };
    
    risultatiFiltrati.forEach(item => {
        if (buckets[item.tipo]) buckets[item.tipo].push(item);
    });

    // 2. LIMITAZIONE
    const risultatiLimitati = [
        ...buckets.condivisa.slice(0, 4),
        ...buckets.privata.slice(0, 4),
        ...buckets['pop-bus'].slice(0, 4)
    ].slice(0, 12);

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

    // 3. FORMATTAZIONE E PRICING
    return (await Promise.all(risultatiLimitati.map(async (item) => {
        try {
            // GESTIONE PROPOSTA VIRTUALE (Innesco Proattivo)
            if (item.id === 'virtual_pop_pending') {
                // Utilizziamo calcolaPrezzo anche per la proposta virtuale per coerenza
                const p = await calcolaPrezzo(
                    { tipo: 'pop-bus' },
                    richiesta.posti_richiesti || 1,
                    'pop-bus',
                    distKmRichiesta,
                    distKmRichiesta,
                    0,
                    richiesta.classe || 'STANDARD'
                );
                const prezzoVal = Number(p) || 0;

                return {
                    id: item.id,
                    tipo: item.tipo,
                    colore_ui: UI_CONFIG[item.tipo]?.colore || '#9E9E9E',
                    classe: richiesta.classe || 'STANDARD',
                    localitaOrigine,
                    localitaDestinazione,
                    oraPartenza: getSafeISO(richiesta.start_datetime || Date.now()),
                    oraArrivo: 'N/D',
                    prezzo: prezzoVal,
                    prezzo_display: `~ ${Math.ceil(prezzoVal)}€`,
                    postiDisponibili: 0,
                    postiTotali: 0,
                    is_pool: true,
                    messaggio: item.messaggio || "Prezzo stimato. Ottimizzazione in corso...",
                    servizi: {}
                };
            }

            // GESTIONE RISULTATI REALI
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
            ).catch(err => { 
                console.error(`[ERROR] Pricing fallito per ID ${item.id}:`, err); 
                return distKmCalc * 0.50; 
            });
            
            const prezzoVal = Number(p) || 0;

            return {
                id: item.is_pool 
                    ? (item.missione_id ? `ret_${item.missione_id}` : `dir_${item.direttrice_id}`)
                    : (item.id || `slot_${item.veicolo_id}`),
                veicolo_id: item.veicolo_id || (item.id && typeof item.id === 'string' && item.id.startsWith('priv_') ? item.id.split('_')[1] : null),
                tipo: item.tipo,
                colore_ui: UI_CONFIG[item.tipo]?.colore || '#9E9E9E',
                classe: item.classe || 'STANDARD',
                direttrice_id: item.direttrice_id || null,
                missione_id: item.missione_id || null,
                aggancio_info: item.aggancio || null,
                localitaOrigine,
                localitaDestinazione,
                oraPartenza,
                oraArrivo,
                prezzo: prezzoVal,
                prezzo_display: Math.ceil(prezzoVal).toString(),
                postiDisponibili: item.posti_disponibili || 0,
                postiTotali: Number(item.posti_totali || 8),
                is_pool: !!item.is_pool,
                is_nuova_proposta: item.tipo_corsa === 'nuova_proposta',
                messaggio: item.messaggio || null,
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