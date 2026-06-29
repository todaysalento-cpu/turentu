import { calcolaPrezzo } from '../../../utils/pricing.util.js';
import { getLocalitaSafe } from '../../../utils/maps.util.js';

const localitaCache = new Map();
const VELOCITA_MEDIA_KM_MIN = 1.0; 

const UI_CONFIG = {
    'pop-bus': { colore: '#FF9800' }, 
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

/**
 * Funzione protetta per determinare l'arrivo
 * Restituisce null se la data di partenza non è valida
 */
const determinaArrivo = (partenzaISO, distanzaMetri) => {
    try {
        const d = new Date(partenzaISO);
        if (isNaN(d.getTime())) return null;

        const distanzaKm = (Number(distanzaMetri) || 0) / 1000;
        const durataMinuti = Math.max(30, Math.round(distanzaKm / VELOCITA_MEDIA_KM_MIN));
        
        d.setMinutes(d.getMinutes() + durataMinuti);
        return d.toISOString();
    } catch (e) {
        return null;
    }
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
        const t = String(item.tipo || "").toLowerCase().trim();
        if (t === 'condivisa') {
            buckets.condivisa.push(item);
        } else if (t === 'privata' || t === 'privato') {
            buckets.privata.push(item);
        } else if (t.includes('pop')) {
            buckets['pop-bus'].push(item);
        }
    });

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
    const oraPartenzaISO = getSafeISO(richiesta.start_datetime || Date.now());

    const results = await Promise.all(risultatiLimitati.map(async (item) => {
        if (!item) return null;
        try {
            const t = String(item.tipo || "").toLowerCase().trim();
            const tipoCoerente = t.includes('pop') ? 'pop-bus' : (t.includes('priv') ? 'privata' : 'condivisa');
            const itemId = String(item.id || "");

            // 1. LOGICA VIRTUAL (POP-BUS)
            if (itemId.startsWith('virtual_pop_')) {
                const poolSicuro = (item.veicoli_pool_ids && item.veicoli_pool_ids.length > 0) ? item.veicoli_pool_ids : [];
                const p = await calcolaPrezzo({ ...item, veicoli_pool_ids: poolSicuro }, richiesta.posti_richiesti || 1, 'pop-bus', distKmRichiesta, distKmRichiesta, 0, item.classe || 'STANDARD');
                const prezzoVal = Math.max(1, Math.ceil(Number(p.prezzo) || 5));

                return {
                    id: itemId,
                    tipo: 'pop-bus',
                    colore_ui: UI_CONFIG['pop-bus'].colore,
                    classe: item.classe || 'STANDARD',
                    localitaOrigine,
                    localitaDestinazione,
                    oraPartenza: oraPartenzaISO,
                    oraArrivo: determinaArrivo(oraPartenzaISO, distMetriRichiesta), // Stima calcolata
                    prezzo: prezzoVal,
                    prezzo_display: `~ ${prezzoVal}€`,
                    posti_necessari_break_even: p.targetPasseggeri || 1,
                    messaggio: item.messaggio || null,
                    postiDisponibili: 0,
                    postiTotali: 0,
                    is_pool: true,
                    veicoli_pool_ids: poolSicuro,
                    servizi: {}
                };
            }

            // 2. LOGICA STANDARD
            let distMetri = item.is_pool ? (item.distanza || Math.abs(Number(item.endOffset || 0) - Number(item.startOffset || 0))) : distMetriRichiesta;
            if (!distMetri || isNaN(distMetri) || distMetri <= 0) distMetri = 1000;
            
            const p = await calcolaPrezzo(item, richiesta.posti_richiesti || 1, tipoCoerente, distMetri/1000, item.distanzaTotaleRotte || (distMetri/1000), 0, item.classe).catch(() => ({ prezzo: (distMetri/1000) * 0.50 }));
            const prezzoVal = Math.max(1, Math.ceil(Number(p.prezzo) || 1));

            return {
                id: itemId || `slot_${item.veicolo_id}`,
                tipo: tipoCoerente,
                colore_ui: UI_CONFIG[tipoCoerente]?.colore || '#9E9E9E',
                classe: item.classe || 'STANDARD',
                localitaOrigine,
                localitaDestinazione,
                oraPartenza: oraPartenzaISO,
                oraArrivo: determinaArrivo(oraPartenzaISO, distMetri),
                prezzo: prezzoVal,
                prezzo_display: prezzoVal.toString(),
                postiDisponibili: item.posti_disponibili || 0,
                postiTotali: Number(item.posti_totali || 8),
                is_pool: !!item.is_pool,
                messaggio: item.messaggio || null,
                servizi: parseServizi(item.servizi)
            };
        } catch (err) {
            console.error(`💥 [FORMAT] Errore su ID ${item?.id}:`, err);
            return null;
        }
    }));

    return results.filter(r => r !== null);
}