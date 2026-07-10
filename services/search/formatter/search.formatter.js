import { calcolaPrezzo } from '../../../utils/pricing.util.js';
import { getLocalitaSafe, getDurataDistanza } from '../../../utils/maps.util.js';

const localitaCache = new Map();

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

const determinaArrivoReale = (partenzaISO, durataMinuti) => {
    try {
        const d = new Date(partenzaISO);
        if (isNaN(d.getTime())) return null;

        d.setMinutes(d.getMinutes() + Math.max(1, Math.round(durataMinuti)));
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

    // Interrogazione a Google Maps per la tratta principale della richiesta
    const coordOrigine = richiesta.coord;
    const coordDestinazione = richiesta.coordDest;
    const mapInfo = await getDurataDistanza(coordOrigine, coordDestinazione);

    const distKmRichiesta = mapInfo.distanzaKm > 0 ? mapInfo.distanzaKm : (Number(richiesta.distanzaMetri || 1000) / 1000);
    const distMetriRichiesta = distKmRichiesta * 1000;
    const durataMinutiRichiesta = mapInfo.durataMs > 0 ? (mapInfo.durataMs / 60000) : Math.max(30, Math.round(distKmRichiesta / 1.0));

    const oraPartenzaISO = getSafeISO(richiesta.start_datetime || Date.now());

    const results = await Promise.all(risultatiLimitati.map(async (item) => {
        if (!item) return null;
        try {
            const t = String(item.tipo || "").toLowerCase().trim();
            const tipoCoerente = t.includes('pop') ? 'pop-bus' : (t.includes('priv') ? 'privata' : 'condivisa');
            const itemId = String(item.id || "");

            // ✅ Recupero sicuro di marca/modello supportando sia proprietà dirette che annidate
            const marcaVal = item.marca || item.veicolo?.marca || '';
            const modelloVal = item.modello || item.veicolo?.modello || '';

            // Calcolo distanza specifica per elementi di tipo pool o standard
            let distMetriItem = distMetriRichiesta;
            if (item.is_pool) {
                distMetriItem = item.distanza || Math.abs(Number(item.endOffset || 0) - Number(item.startOffset || 0)) || distMetriRichiesta;
            }
            const distKmItem = distMetriItem / 1000;
            const durataMinutiItem = mapInfo.durataMs > 0 ? (mapInfo.durataMs / 60000) : Math.max(30, Math.round(distKmItem / 1.0));

            // 1. LOGICA VIRTUAL (POP-BUS)
            if (itemId.startsWith('virtual_pop_')) {
                const poolSicuro = (item.veicoli_pool_ids && item.veicoli_pool_ids.length > 0) ? item.veicoli_pool_ids : [];
                const p = await calcolaPrezzo({ ...item, veicoli_pool_ids: poolSicuro }, richiesta.posti_richiesti || 1, 'pop-bus', distKmRichiesta, distKmRichiesta, 0, item.classe || 'STANDARD');
                const prezzoVal = Math.max(1, Math.ceil(Number(p.prezzo) || 5));

                return {
                    id: itemId,
                    veicolo_id: null,
                    tipo: 'pop-bus',
                    colore_ui: UI_CONFIG['pop-bus'].colore,
                    classe: item.classe || 'STANDARD',
                    marca: marcaVal,
                    modello: modelloVal,
                    localitaOrigine,
                    localitaDestinazione,
                    oraPartenza: oraPartenzaISO,
                    oraArrivo: determinaArrivoReale(oraPartenzaISO, durataMinutiRichiesta),
                    distanza_metri: distMetriRichiesta,
                    durata_minuti: Math.round(durataMinutiRichiesta),
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
            const p = await calcolaPrezzo(item, richiesta.posti_richiesti || 1, tipoCoerente, distKmItem, item.distanzaTotaleRotte || distKmItem, 0, item.classe).catch(() => ({ prezzo: distKmItem * 0.50 }));
            const prezzoVal = Math.max(1, Math.ceil(Number(p.prezzo) || 1));

            return {
                id: itemId || `slot_${item.veicolo_id}`,
                veicolo_id: item.veicolo_id,
                tipo: tipoCoerente,
                colore_ui: UI_CONFIG[tipoCoerente]?.colore || '#9E9E9E',
                classe: item.classe || 'STANDARD',
                marca: marcaVal,
                modello: modelloVal,
                localitaOrigine,
                localitaDestinazione,
                oraPartenza: oraPartenzaISO,
                oraArrivo: determinaArrivoReale(oraPartenzaISO, durataMinutiItem),
                distanza_metri: distMetriItem,
                durata_minuti: Math.round(durataMinutiItem),
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