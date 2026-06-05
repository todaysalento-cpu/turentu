import { calcolaPrezzo } from '../../../utils/pricing.util.js';
import { getLocalitaSafe } from '../../../utils/maps.util.js';

// ... (resto delle costanti e funzioni helper invariate)

export async function formatResults(richiesta, risultatiFiltrati, corseOriginali) {
    // ... (parte iniziale di recupero localita invariata)

    // ... (costruzione risultatiDaFormattare invariata)

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

            // LOG INGRESSO GENERALE
            console.log(`[DEBUG] Elaborazione ID: ${item.id || 'N/A'}, Tipo: ${item.tipo}, Km: ${distKm}`);

            // A. Caso Pool
            if (item.is_pool) {
                console.log(`[DEBUG] Chiamata calcolaPrezzo POOL. Veicolo: ${item.veicolo_id}, Posti: ${richiesta.posti_richiesti}`);
                const p = await calcolaPrezzo(item, richiesta.posti_richiesti, 'pop-bus', distKm)
                    .catch((err) => {
                        console.error(`[ERROR] Fallimento calcolo POOL:`, err);
                        return 0;
                    });
                
                console.log(`[DEBUG] Risultato POOL: ${p}`);
                const prezzoVal = Number(p) || 0;
                return { 
                    ...item, 
                    localitaOrigine, localitaDestinazione, 
                    prezzo: prezzoVal, 
                    prezzo_display: prezzoVal.toFixed(0),
                    marca: "Pop Bus", modello: "Condiviso"
                };
            }

            // B. Caso Slot Privato
            if (item.tipo === 'privata_slot') {
                console.log(`[DEBUG] Chiamata calcolaPrezzo PRIVATA. Veicolo: ${item.veicolo_id}`);
                const p = await calcolaPrezzo(item, richiesta.posti_richiesti, 'privata', distKm)
                    .catch((err) => {
                        console.error(`[ERROR] Fallimento calcolo PRIVATA:`, err);
                        return distKm * 0.5;
                    });
                
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

            // C. Caso Corsa Condivisa
            const distItemKm = (item.distanza || distTrattaMetri) / 1000;
            console.log(`[DEBUG] Chiamata calcolaPrezzo CONDIVISA. Tipo: ${item.tipo_corsa}, Km: ${distItemKm}`);
            const p = await calcolaPrezzo(item, richiesta.posti_richiesti, item.tipo_corsa, distItemKm)
                .catch((err) => {
                    console.error(`[ERROR] Fallimento calcolo CONDIVISA:`, err);
                    return distItemKm * 0.45;
                });
            
            console.log(`[DEBUG] Risultato CONDIVISA: ${p}`);
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
            console.error(`💥 Errore formattazione risultato per ${item.id}:`, err);
            return null;
        }
    }))).filter(r => r !== null);
}