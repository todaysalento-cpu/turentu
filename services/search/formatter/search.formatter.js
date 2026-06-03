import * as turf from '@turf/turf';
import { v4 as uuidv4 } from 'uuid';
import { calcolaPrezzo } from '../../../utils/pricing.util.js';
import { getLocalitaSafe, getDurataDistanza } from '../../../utils/maps.util.js';
import * as CacheModule from '../search.cache.js';

const localitaCache = new Map();

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

/**
 * FormatResults ottimizzato per ridurre l'I/O asincrono e migliorare le performance
 */
export async function formatResults(richiesta, risultatiFiltrati, corseOriginali, injectedVeicoliMap = null) {
    const veicoliMap = injectedVeicoliMap || CacheModule.CacheStore.veicoliCache;

    // 1. OTTIMIZZAZIONE: Recupero località in parallelo una sola volta
    const [localitaOrigine, localitaDestinazione] = await Promise.all([
        getLocalitaSafeCached(richiesta.coord),
        getLocalitaSafeCached(richiesta.coordDest)
    ]);

    // 2. SEPARAZIONE DEI RISULTATI
    const slots = risultatiFiltrati.filter(item => item.is_slot);
    const corseStandard = risultatiFiltrati.filter(item => !item.is_slot && !(item.tipo_corsa === 'riempimento' && item.stato === 'da_attivare'));
    const riempimentiInAttesa = risultatiFiltrati.filter(item => !item.is_slot && item.tipo_corsa === 'riempimento' && item.stato === 'da_attivare');

    let risultatiDaFormattare = [...slots, ...corseStandard];

    // 3. AGGREGAZIONE RIEMPIMENTI (Logica Pool)
    if (riempimentiInAttesa.length > 0) {
        const poolId = 'pool_' + uuidv4();
        const prezzi = riempimentiInAttesa.map(r => Number(r.prezzo_fisso || 0)).filter(p => p > 0);
        
        risultatiDaFormattare.push({
            id: poolId,
            tipo: 'riempimento_pool',
            corse_ids: riempimentiInAttesa.map(r => r.id),
            rangePrezzo: {
                min: prezzi.length ? Math.min(...prezzi) : 0,
                max: prezzi.length ? Math.max(...prezzi) : 0
            },
            percorsoVisualizzato: riempimentiInAttesa[0].decodedCoords,
            is_pool: true
        });
    }

    // 4. FORMATTAZIONE UNIFICATA
    const formattati = await Promise.all(risultatiDaFormattare.map(async (item) => {
        try {
            // --- GESTIONE POOL ---
            if (item.is_pool) {
                return { 
                    ...item, 
                    localitaOrigine, 
                    localitaDestinazione, 
                    messaggio: "Corse in attesa di soglia: pre-autorizza il costo massimo per unirti al pool." 
                };
            }

            // --- GESTIONE SLOT ---
            if (item.is_slot) {
                const vId = Number(item.veicolo_id);
                const v = !isNaN(vId) ? veicoliMap.get(vId) : null;
                const origine = v ? { lat: v.lat, lon: v.lon } : richiesta.coord;
                const viaggio = await getDurataDistanza(origine, richiesta.coordDest);
                const dist = viaggio.distanzaKm || 0;
                const prezzo = await calcolaPrezzo(item, richiesta.posti_richiesti, 'disponibile', dist, dist);

                return {
                    id: item.id || uuidv4(),
                    veicolo_id: vId,
                    marca: v?.marca ?? "Servizio",
                    tipo: 'disponibile',
                    localitaOrigine,
                    localitaDestinazione,
                    oraPartenza: getSafeISO(item.start_datetime || new Date()),
                    prezzo: Number(prezzo?.toFixed(2)) || 0,
                    postiDisponibili: Number(item.posti_totali || 0),
                    percorsoVisualizzato: null
                };
            }

            // --- GESTIONE CORSE STANDARD ---
            const decodedCoords = item.decodedCoords || [];
            const startIdx = item.startIdx ?? 0;
            const endIdx = item.endIdx ?? (decodedCoords.length - 1);
            
            // Calcolo percorso dinamico
            const line = turf.lineString(decodedCoords);
            const segment = (startIdx < endIdx && decodedCoords.length > 1) 
                ? turf.lineSlice(turf.point(decodedCoords[startIdx]), turf.point(decodedCoords[endIdx]), line) 
                : line;
            
            const totalPoints = decodedCoords.length;
            const ratio = (totalPoints > 1) ? (endIdx - startIdx) / (totalPoints - 1) : 1;
            const distDinamica = (item.distanzaKm || item.distanza || 0) * ratio;
            const prezzo = await calcolaPrezzo(item, richiesta.posti_richiesti, item.stato, distDinamica, distDinamica);

            return {
                id: item.id,
                veicolo_id: Number(item.veicolo_id),
                tipo: item.tipo_corsa,
                fermata_fusione: !!item.fermata_fusione,
                localitaOrigine,
                localitaDestinazione,
                prezzo: Number(prezzo?.toFixed(2)) || 0,
                postiDisponibili: Number(item.postiDisponibili || 0),
                percorsoVisualizzato: segment.geometry.coordinates
            };

        } catch (err) {
            console.error(`💥 Errore formattazione ${item?.id}:`, err);
            return null;
        }
    }));

    return formattati.filter(r => r !== null);
}