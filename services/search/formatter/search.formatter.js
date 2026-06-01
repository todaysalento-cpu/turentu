import { v4 as uuidv4 } from 'uuid';
import { calcolaPrezzo } from '../../../utils/pricing.util.js';
import { getLocalitaSafe, getDurataDistanza } from '../../../utils/maps.util.js';
import * as CacheModule from '../search.cache.js';

const localitaCache = new Map();

// Helper per validare le date e prevenire RangeError
const getSafeISO = (dateInput) => {
    const d = new Date(dateInput);
    return !isNaN(d.getTime()) ? d.toISOString() : new Date().toISOString();
};

async function getLocalitaSafeCached(coord) {
    if (!coord || typeof coord.lat === 'undefined') return "N/D";
    const key = `${coord.lat.toFixed(3)}_${coord.lon.toFixed(3)}`;
    if (localitaCache.has(key)) return localitaCache.get(key);
    const loc = await getLocalitaSafe(coord);
    localitaCache.set(key, loc);
    return loc;
}

export async function formatResults(richiesta, risultatiFiltrati, corseOriginali, injectedVeicoliMap = null) {
    const veicoliMap = injectedVeicoliMap || CacheModule.CacheStore.veicoliCache;

    // Taglio chirurgico: Max 5 slot e 5 corse
    const slots = risultatiFiltrati.filter(item => item.is_slot).slice(0, 5);
    const corse = risultatiFiltrati.filter(item => !item.is_slot).slice(0, 5);
    const risultatiDaFormattare = [...slots, ...corse];

    return (await Promise.all(risultatiDaFormattare.map(async (item) => {
        try {
            const vId = Number(item.veicolo_id);
            const v = !isNaN(vId) ? veicoliMap.get(vId) : null;

            // --- 1. GESTIONE SLOT ---
            if (item.is_slot) {
                const origine = v ? { lat: v.lat, lon: v.lon } : richiesta.coord;
                const viaggio = await getDurataDistanza(origine, richiesta.coordDest);
                const dist = viaggio.distanzaKm || 0;
                const prezzo = await calcolaPrezzo(item, richiesta.posti_richiesti, 'disponibile', dist, dist);

                const baseDate = item.start_datetime ? new Date(item.start_datetime) : new Date();
                const arrivalDate = new Date(baseDate.getTime() + (viaggio.durataMs || 3600000));

                return {
                    id: item.id || uuidv4(),
                    veicolo_id: vId,
                    marca: v?.marca ?? "Servizio",
                    modello: v?.modello ?? "Disponibilità oraria",
                    tipo: 'disponibile',
                    localitaOrigine: await getLocalitaSafeCached(richiesta.coord),
                    localitaDestinazione: await getLocalitaSafeCached(richiesta.coordDest),
                    oraPartenza: getSafeISO(baseDate),
                    oraArrivo: getSafeISO(arrivalDate),
                    distanzaKm: Number(dist.toFixed(2)),
                    prezzo: Number(prezzo?.toFixed(2)) || 0,
                    stato: 'disponibile',
                    postiDisponibili: Number(item.posti_totali || 0),
                    percorsoVisualizzato: null
                };
            }

            // --- 2. GESTIONE CORSE ---
            const prezzo = await calcolaPrezzo(
                item, 
                richiesta.posti_richiesti, 
                item.stato, 
                item.distanzaKm || item.distanza, 
                item.distanza
            );

            return {
                id: item.id,
                veicolo_id: vId,
                marca: v?.marca ?? "N/A", 
                modello: v?.modello ?? "Veicolo",
                tipo: item.tipo_corsa || 'condivisa',
                localitaOrigine: await getLocalitaSafeCached(richiesta.coord),
                localitaDestinazione: await getLocalitaSafeCached(richiesta.coordDest),
                oraPartenza: getSafeISO(item.oraPartenza || item.start_datetime),
                oraArrivo: getSafeISO(item.oraArrivo || item.start_datetime),
                distanzaKm: Number(item.distanzaKm || item.distanza || 0),
                prezzo: Number(prezzo?.toFixed(2)) || 0,
                stato: item.stato || 'prenotabile',
                postiDisponibili: Number(item.postiDisponibili),
                percorsoVisualizzato: item.decodedCoords || null
            };

        } catch (err) {
            console.error(`💥 Errore formattazione ${item?.id}:`, err);
            return null;
        }
    }))).filter(r => r !== null);
}