import { calcolaPrezzo } from '../../../utils/pricing.util.js';
import { getLocalitaSafe } from '../../../utils/maps.util.js';

const localitaCache = new Map();
const SOGLIA_ATTIVAZIONE_PERCENT = 0.6; 

const safeDate = (dateInput) => {
    const d = new Date(dateInput);
    return !isNaN(d.getTime()) ? d : new Date();
};

const getSafeISO = (dateInput) => safeDate(dateInput).toISOString();

const normalizzaServizi = (servizi) => {
    if (Array.isArray(servizi)) {
        return servizi.reduce((acc, s) => ({ ...acc, [s]: true }), {});
    }
    return servizi || {};
};

async function getLocalitaSafeCached(locInput) {
    if (typeof locInput === 'string') return locInput;
    if (locInput && locInput.description) return locInput.description;
    if (!locInput || typeof locInput.lat === 'undefined') return "N/D";
    
    const key = `${locInput.lat.toFixed(3)}_${locInput.lon.toFixed(3)}`;
    if (localitaCache.has(key)) return localitaCache.get(key);
    
    const loc = await getLocalitaSafe(locInput);
    localitaCache.set(key, loc);
    return loc;
}

export async function formatResults(richiesta, risultatiFiltrati, corseOriginali) {
    console.log(`[DEBUG] Inizio formattazione per ${risultatiFiltrati.length} risultati.`);
    
    const [localitaOrigine, localitaDestinazione] = await Promise.all([
        getLocalitaSafeCached(richiesta.localitaOrigine || richiesta.coord),
        getLocalitaSafeCached(richiesta.localitaDestinazione || richiesta.coordDest)
    ]);

    const popBusPool = risultatiFiltrati.filter(item => item.is_pool);
    const slotPrivati = risultatiFiltrati.filter(item => item.tipo === 'privata_slot');
    const corseCondivise = risultatiFiltrati.filter(item => !item.is_pool && item.tipo !== 'privata_slot');

    let risultatiDaFormattare = [...corseCondivise, ...slotPrivati];

    if (popBusPool.length > 0) {
        // FILTRO RIGOROSO: Escludiamo dati sporchi (es. posti > 50)
        const poolValido = popBusPool.filter(item => {
            const p = Number(item.posti_totali || 0);
            return p > 0 && p <= 50; 
        });

        if (poolValido.length > 0) {
            const postiTotaliPool = poolValido.reduce((acc, curr) => acc + Number(curr.posti_totali || 0), 0);
            const postiPrenotatiPool = poolValido.reduce((acc, curr) => acc + Number(curr.posti_prenotati || 0), 0);
            const postiMinimiPerAttivazione = Math.ceil(postiTotaliPool * SOGLIA_ATTIVAZIONE_PERCENT);
            const mancanti = Math.max(0, postiMinimiPerAttivazione - postiPrenotatiPool);
            
            // ESTRAZIONE ID VEICOLI PULITI
            const idsVeicoliPool = poolValido.map(item => Number(item.veicolo_id)).filter(id => !isNaN(id));

            risultatiDaFormattare.push({
                id: 'pool_pop_bus_fixed_id',
                is_pool: true,
                tipo: 'pop-bus',
                posti_totali: postiTotaliPool,
                posti_prenotati: postiPrenotatiPool,
                mancanti: mancanti,
                veicoli_pool_ids: idsVeicoliPool, // Ora popolato con soli ID validi
                messaggio: mancanti > 0 ? `Pop Bus in formazione: mancano ${mancanti} posti.` : `Pop Bus attivo!`
            });
        }
    }

    const distTrattaMetri = Number(richiesta.distanzaMetri || 10000);
    const distKm = distTrattaMetri / 1000;

    return (await Promise.all(risultatiDaFormattare.map(async (item) => {
        try {
            const veicoloInfo = {
                marca: item.marca || 'N/D',
                modello: item.modello || 'N/D',
                rating: Number(item.rating || 0),
                servizi: normalizzaServizi(item.servizi)
            };

            if (item.is_pool) {
                const p = await calcolaPrezzo(item, richiesta.posti_richiesti, 'pop-bus', distKm, distKm);
                const prezzoVal = Number(p) || 0;
                return { 
                    ...item, 
                    localitaOrigine, localitaDestinazione, 
                    prezzo: prezzoVal, 
                    prezzo_display: prezzoVal.toFixed(0), 
                    marca: "Pop Bus", modello: "Condiviso"
                };
            }

            if (item.tipo === 'privata_slot') {
                const p = await calcolaPrezzo(item, richiesta.posti_richiesti, 'privata', distKm, distKm);
                const prezzoVal = Number(p) || 0;
                return {
                    id: `slot_privato_${item.veicolo_id}`,
                    veicolo_id: Number(item.veicolo_id),
                    tipo: 'privata', ...veicoloInfo,
                    localitaOrigine, localitaDestinazione,
                    oraPartenza: getSafeISO(richiesta.start_datetime),
                    prezzo: prezzoVal, 
                    prezzo_display: prezzoVal.toFixed(0), 
                    postiDisponibili: Number(item.posti_totali || 0),
                    postiTotali: Number(item.posti_totali || 0),
                    is_privato: true
                };
            }

            const distItemKm = (item.distanza || distTrattaMetri) / 1000;
            const p = await calcolaPrezzo(item, richiesta.posti_richiesti, item.tipo_corsa, distItemKm, distItemKm);
            const prezzoVal = Number(p) || 0;

            return {
                id: item.id,
                veicolo_id: Number(item.veicolo_id || 0),
                tipo: item.tipo_corsa || 'standard',
                ...veicoloInfo,
                localitaOrigine, localitaDestinazione,
                oraPartenza: getSafeISO(item.start_datetime || new Date()),
                prezzo: prezzoVal, 
                prezzo_display: prezzoVal.toFixed(0), 
                postiDisponibili: Math.max(0, Number(item.posti_totali || 0) - Number(item.posti_prenotati || 0)),
                postiTotali: Number(item.posti_totali || 0)
            };
        } catch (err) {
            console.error(`💥 [ERROR] Formattazione fallita per ${item.id}:`, err);
            return null;
        }
    }))).filter(r => r !== null);
}