import { v4 as uuidv4 } from 'uuid';
import { calcolaPrezzo } from '../../../utils/pricing.util.js';
import { getLocalitaSafe } from '../../../utils/maps.util.js';
import * as CacheModule from '../search.cache.js';
import { redisClient } from '../../../redis.js';
import ngeohash from 'ngeohash';

const MATCHING_PRECISION = 5;

/**
 * Logica pura di interpolazione basata su ZSET
 */
function calcolaDettagliTratta(item, idxStart, idxEnd) {
    if (idxStart === null || idxEnd === null || idxEnd <= idxStart) return null;

    const totalPoints = item.decodedCoords.length;
    const ratioPartenza = idxStart / totalPoints;
    const ratioSegmento = (idxEnd - idxStart) / totalPoints;
    const durataTotaleMs = Number(item.durata_ms || 0);
    
    const oraPartenza = new Date(new Date(item.start_datetime).getTime() + (durataTotaleMs * ratioPartenza));
    const oraArrivo = new Date(oraPartenza.getTime() + (durataTotaleMs * ratioSegmento));
    const distanzaSegmentoKm = Number(item.distanza || 0) * ratioSegmento;

    return { oraPartenza, oraArrivo, distanzaSegmentoKm };
}

async function getDettagliTrattaRedis(corsaIds, startCoord, endCoord) {
    const hStart = ngeohash.encode(startCoord.lat, startCoord.lon, MATCHING_PRECISION);
    const hEnd = ngeohash.encode(endCoord.lat, endCoord.lon, MATCHING_PRECISION);
    const pipeline = redisClient.multi();
    corsaIds.forEach(id => {
        pipeline.zScore(`corsa:percorso_hash:${id}`, hStart);
        pipeline.zScore(`corsa:percorso_hash:${id}`, hEnd);
    });
    return await pipeline.exec();
}

const localitaCache = new Map();
async function getLocalitaSafeCached(coord) {
    if (!coord || typeof coord.lat === 'undefined') return "N/D";
    const key = `${coord.lat.toFixed(3)}_${coord.lon.toFixed(3)}`;
    if (localitaCache.has(key)) return localitaCache.get(key);
    
    const loc = await getLocalitaSafe(coord);
    localitaCache.set(key, loc);
    return loc;
}

export async function formatResults(richiesta, slotsFiltrati, corseFiltrate, injectedVeicoliMap = null) {
    const allItems = [...corseFiltrate.slice(0, 5), ...slotsFiltrati.slice(0, 5)].slice(0, CacheModule.TOP_RESULTS || 10);
    const veicoliMap = injectedVeicoliMap || CacheModule.CacheStore.veicoliCache;
    
    const corsaItems = allItems.filter(item => !item.is_slot && !!item.start_datetime && item.decodedCoords?.length > 0);
    const zsetResults = corsaItems.length > 0 
        ? await getDettagliTrattaRedis(corsaItems.map(c => c.id), richiesta.coord, richiesta.coordDest) 
        : [];

    return (await Promise.all(allItems.map(async (item) => {
        try {
            const vId = Number(item.veicolo_id);
            const v = !isNaN(vId) ? veicoliMap.get(vId) : null;

            // --- 1. GESTIONE SLOT ---
            if (item.is_slot) {
                // Ora usiamo le coordinate reali del veicolo per la localitaOrigine
                const coordVeicolo = v ? { lat: v.lat, lon: v.lon } : richiesta.coord;
                
                return {
                    id: item.id || uuidv4(),
                    veicolo_id: vId,
                    marca: v?.marca ?? "Servizio",
                    modello: v?.modello ?? "Disponibilità oraria",
                    localitaOrigine: await getLocalitaSafeCached(coordVeicolo),
                    localitaDestinazione: await getLocalitaSafeCached(richiesta.coordDest),
                    oraPartenza: item.start_datetime || new Date().toISOString(),
                    oraArrivo: "Da concordare",
                    distanzaKm: item._distanzaKm ? Number(item._distanzaKm.toFixed(2)) : 0,
                    prezzo: 0,
                    stato: 'disponibile',
                    postiDisponibili: Number(item.posti_disponibili ?? 0),
                    percorsoVisualizzato: null
                };
            }

            // --- 2. GESTIONE CORSE ---
            let oraPartenza = new Date(item.start_datetime || Date.now());
            let oraArrivo = new Date(oraPartenza.getTime() + (item.durata_ms || 0));
            let distanza = Number(item.distanza || 0);

            if (item.start_datetime && item.decodedCoords?.length > 0) {
                const zIndex = corsaItems.findIndex(c => c.id === item.id);
                if (zIndex !== -1 && zsetResults[zIndex * 2] !== null) {
                    const dettagli = calcolaDettagliTratta(item, Number(zsetResults[zIndex * 2]), Number(zsetResults[zIndex * 2 + 1]));
                    if (dettagli) ({ oraPartenza, oraArrivo, distanzaSegmentoKm: distanza } = dettagli);
                }
            }

            const prezzo = await calcolaPrezzo(item, richiesta.posti_richiesti, item.stato, distanza, Number(item.distanza || 0));

            return {
                id: item.id || uuidv4(),
                veicolo_id: vId,
                marca: v?.marca ?? "N/A", 
                modello: v?.modello ?? "Veicolo",
                localitaOrigine: await getLocalitaSafeCached(richiesta.coord),
                localitaDestinazione: await getLocalitaSafeCached(richiesta.coordDest),
                oraPartenza: oraPartenza.toISOString(),
                oraArrivo: oraArrivo.toISOString(),
                distanzaKm: Number(distanza.toFixed(2)),
                prezzo: Number(prezzo?.toFixed(2)) || 0,
                stato: item.stato || 'prenotabile',
                postiDisponibili: Number(item.postiDisponibili ?? 0),
                percorsoVisualizzato: item.decodedCoords || null
            };
        } catch (err) {
            console.error(`💥 Errore formattazione ${item?.id}:`, err);
            return null;
        }
    }))).filter(r => r !== null);
}