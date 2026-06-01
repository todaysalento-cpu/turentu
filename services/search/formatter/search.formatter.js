import { v4 as uuidv4 } from 'uuid';
import { calcolaPrezzo } from '../../../utils/pricing.util.js';
import { getLocalitaSafe } from '../../../utils/maps.util.js';
import * as CacheModule from '../search.cache.js';

const localitaCache = new Map();
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

    return (await Promise.all(risultatiFiltrati.map(async (item) => {
        try {
            const vId = Number(item.veicolo_id);
            const v = !isNaN(vId) ? veicoliMap.get(vId) : null;

            // --- 1. GESTIONE SLOT (Generici) ---
            if (item.is_slot) {
                return {
                    id: item.id || uuidv4(),
                    veicolo_id: vId,
                    marca: v?.marca ?? "Servizio",
                    modello: v?.modello ?? "Disponibilità oraria",
                    tipo: 'disponibile',
                    localitaOrigine: await getLocalitaSafeCached(richiesta.coord),
                    localitaDestinazione: await getLocalitaSafeCached(richiesta.coordDest),
                    oraPartenza: item.start_datetime,
                    oraArrivo: item.start_datetime, // Slot basati su disponibilità oraria
                    distanzaKm: 0,
                    prezzo: 0, // Calcolato a consuntivo o tramite altro servizio
                    stato: 'disponibile',
                    postiDisponibili: Number(item.posti_totali || 0),
                    percorsoVisualizzato: null
                };
            }

            // --- 2. GESTIONE CORSE (Già filtrate e calcolate) ---
            // Niente ricalcoli qui: 'item' contiene già i dati corretti dal filtro
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
                oraPartenza: item.oraPartenza || item.start_datetime,
                oraArrivo: item.oraArrivo || item.start_datetime,
                distanzaKm: Number(item.distanzaKm || item.distanza || 0),
                prezzo: Number(prezzo?.toFixed(2)) || 0,
                stato: item.stato || 'prenotabile',
                postiDisponibili: Number(item.postiDisponibili), // VALORE CERTO DAL FILTRO
                percorsoVisualizzato: item.decodedCoords || null
            };

        } catch (err) {
            console.error(`💥 Errore formattazione ${item?.id}:`, err);
            return null;
        }
    }))).filter(r => r !== null);
}