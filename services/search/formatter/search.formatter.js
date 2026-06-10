import { calcolaPrezzo } from '../../../utils/pricing.util.js';
import { getLocalitaSafe } from '../../../utils/maps.util.js';

const localitaCache = new Map();
const VELOCITA_MEDIA_KM_MIN = 1.0; 

// ... (safeDate, getSafeISO, parseServizi, determinaArrivo, getLocalitaSafeCached invariati)

export async function formatResults(richiesta, risultatiFiltrati, corseOriginali) {
    console.log(`[DEBUG] Inizio formattazione. Risultati totali: ${risultatiFiltrati.length}`);
    console.log(`[DEBUG] Distanza richiesta (raw): ${richiesta.distanzaMetri}m`);

    const [localitaOrigine, localitaDestinazione] = await Promise.all([
        (typeof richiesta.localitaOrigine === 'string' && richiesta.localitaOrigine !== "N/D") ? richiesta.localitaOrigine : getLocalitaSafeCached(richiesta.coord),
        (typeof richiesta.localitaDestinazione === 'string' && richiesta.localitaDestinazione !== "N/D") ? richiesta.localitaDestinazione : getLocalitaSafeCached(richiesta.coordDest)
    ]);

    // RIMOZIONE FALLBACK 10000: Se è null, deve essere 0 per essere identificato come errore
    const distanzaRealeMetri = Number(richiesta.distanzaMetri || 0);

    return (await Promise.all(risultatiFiltrati.map(async (item) => {
        try {
            // Logica di selezione distanza con log
            const distMetri = Number(item.distMetri || item.distanza || distanzaRealeMetri);
            console.log(`[DEBUG] Pricing ID ${item.id || item.direttrice_id} | Distanza usata: ${distMetri}m`);
            
            const distKmCalc = Math.max(0.1, distMetri / 1000);
            
            const oraPartenza = getSafeISO(item.partenza || item.start_datetime || richiesta.start_datetime);
            const oraArrivo = determinaArrivo(oraPartenza, item.arrivo_datetime, distMetri);
            
            const tipoCalcolo = item.tipo === 'pop-bus' ? 'popbus' : (item.tipo === 'privata_slot' ? 'privata' : (item.tipo_corsa || item.tipo || 'standard'));
            
            console.log(`[DEBUG] Chiamata calcolaPrezzo per ${item.id} | KM: ${distKmCalc.toFixed(2)} | Tipo: ${tipoCalcolo}`);
            
            const p = await calcolaPrezzo(item, richiesta.posti_richiesti, tipoCalcolo, distKmCalc, distKmCalc)
                .catch(err => { 
                    console.error(`[ERROR] Pricing fallito per ${item.id || item.direttrice_id}:`, err); 
                    return distKmCalc * 0.45; 
                });
            
            const prezzoVal = Number(p) || 0;
            // ... (getSafeId e ritorno oggetto invariati)
            
            return {
                id: getSafeId(),
                veicolo_id: Number(item.veicolo_id || 0),
                direttrice_id: item.direttrice_id || null,
                tipo: tipoCalcolo,
                localitaOrigine, 
                localitaDestinazione,
                origine: item.origine || richiesta.coord,
                destinazione: item.destinazione || richiesta.coordDest,
                oraPartenza, 
                oraArrivo,
                marca: item.is_pool ? null : (item.marca || 'N/D'),
                modello: item.is_pool ? null : (item.modello || 'N/D'),
                rating: Number(item.rating || 0),
                servizi: parseServizi(item.servizi),
                prezzo: prezzoVal,
                prezzo_display: prezzoVal.toFixed(0),
                postiDisponibili: item.is_pool ? item.posti_disponibili : Math.max(0, Number(item.posti_totali || 0) - Number(item.posti_prenotati || 0)),
                postiTotali: Number(item.posti_totali || 0),
                is_privato: item.tipo === 'privata_slot',
                is_pool: !!item.is_pool,
                veicoli_pool_ids: item.veicoli_pool_ids || [], 
                messaggio: item.messaggio
            };
        } catch (err) {
            console.error(`💥 Errore formattazione ID ${item.id}:`, err);
            return null;
        }
    }))).filter(r => r !== null);
}