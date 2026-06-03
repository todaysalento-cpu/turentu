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

// Helper per calcolare l'ora di arrivo
const calcolaArrivo = (startISO, durataMinuti = 20) => {
    const d = new Date(startISO);
    d.setMinutes(d.getMinutes() + (durataMinuti || 20));
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

export async function formatResults(richiesta, risultatiFiltrati, corseOriginali, injectedVeicoliMap = null) {
    const veicoliMap = injectedVeicoliMap || CacheModule.CacheStore.veicoliCache;

    const [localitaOrigine, localitaDestinazione] = await Promise.all([
        getLocalitaSafeCached(richiesta.coord),
        getLocalitaSafeCached(richiesta.coordDest)
    ]);

    const slots = risultatiFiltrati.filter(item => item.is_slot);
    const corseStandard = risultatiFiltrati.filter(item => !item.is_slot && !(item.tipo_corsa === 'riempimento' && item.stato === 'da_attivare'));
    const riempimentiInAttesa = risultatiFiltrati.filter(item => !item.is_slot && item.tipo_corsa === 'riempimento' && item.stato === 'da_attivare');

    let risultatiDaFormattare = [...slots, ...corseStandard];

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

    const formattati = await Promise.all(risultatiDaFormattare.map(async (item) => {
        try {
            if (item.is_pool) {
                return { 
                    ...item, 
                    localitaOrigine, 
                    localitaDestinazione, 
                    messaggio: "Corse in attesa di soglia: pre-autorizza il costo massimo per unirti al pool." 
                };
            }

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
                    modello: v?.modello ?? "",
                    tipo: 'disponibile',
                    badge: 'Disponibile',
                    localitaOrigine,
                    localitaDestinazione,
                    oraPartenza: getSafeISO(item.start_datetime || new Date()),
                    oraArrivo: calcolaArrivo(item.start_datetime || new Date(), 30),
                    prezzo: Number(prezzo?.toFixed(2)) || 0,
                    postiDisponibili: Number(item.posti_totali || 0),
                    postiTotali: Number(item.posti_totali || 0),
                    postiPrenotati: 0,
                    percorsoVisualizzato: null
                };
            }

            // GESTIONE CORSE STANDARD
            const decodedCoords = item.decodedCoords || [];
            const startIdx = item.startIdx ?? 0;
            const endIdx = item.endIdx ?? (decodedCoords.length - 1);
            
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
                marca: item.marca || "Veicolo",
                modello: item.modello || "",
                tipo: item.tipo_corsa,
                badge: item.tipo_corsa?.toUpperCase() || 'STANDARD',
                fermata_fusione: !!item.fermata_fusione,
                localitaOrigine,
                localitaDestinazione,
                oraPartenza: getSafeISO(item.start_datetime),
                oraArrivo: item.arrivo_datetime ? getSafeISO(item.arrivo_datetime) : calcolaArrivo(item.start_datetime, 20),
                prezzo: Number(prezzo?.toFixed(2)) || 0,
                postiDisponibili: Number(item.posti_disponibili ?? item.postiDisponibili ?? 0),
                postiTotali: Number(item.posti_totali ?? 0),
                postiPrenotati: Number(item.posti_prenotati ?? 0),
                percorsoVisualizzato: segment.geometry.coordinates
            };

        } catch (err) {
            console.error(`💥 Errore formattazione ${item?.id}:`, err);
            return null;
        }
    }));

    return formattati.filter(r => r !== null);
}