import { pool } from '../db/db.js';

const TARIFF_DEFAULT = { euro_km: 0.50, prezzo_passeggero: 1.00 };
const PREZZO_MINIMO = 0.50;

const CLASSE_MULTIPLIER = { EXPRESS: 1.4, STANDARD: 1.0, SAVER: 0.75 };
const CLASSI_CONFIG = {
    EXPRESS:  { soglia: 0.5, minIndice: 1.5, maxIndice: 99.0 }, 
    STANDARD: { soglia: 0.6, minIndice: 0.3, maxIndice: 1.5 },
    SAVER:    { soglia: 0.9, minIndice: 0.0, maxIndice: 0.3 }
};

const CALCOLA_INDICE = (euro_km, posti) => euro_km / (posti * posti);

export async function getTariffe(veicolo_id) {
    try {
        const { rows } = await pool.query(
            'SELECT euro_km, prezzo_passeggero FROM tariffe WHERE veicolo_id = $1 LIMIT 1',
            [veicolo_id]
        );
        if (rows[0]) {
            return { euro_km: Number(rows[0].euro_km), prezzo_passeggero: Number(rows[0].prezzo_passeggero) };
        }
        return TARIFF_DEFAULT;
    } catch (err) {
        console.error(`⚠ [PRICING] Errore DB per veicolo ${veicolo_id}:`, err);
        return TARIFF_DEFAULT;
    }
}

async function getDettaglioPool(veicoli_ids) {
    if (!veicoli_ids || veicoli_ids.length === 0) return [];
    try {
        const res = await pool.query(
            `SELECT t.veicolo_id, t.euro_km, v.posti_totali as posti 
             FROM tariffe t
             JOIN veicolo v ON t.veicolo_id = v.id 
             WHERE t.veicolo_id = ANY($1)`,
            [veicoli_ids]
        );
        return res.rows.map(r => ({
            id: r.veicolo_id,
            euro_km: Number(r.euro_km),
            posti: Number(r.posti),
            indice: CALCOLA_INDICE(Number(r.euro_km), Number(r.posti))
        }));
    } catch (err) {
        console.error(`❌ [POOL] Errore query pool:`, err);
        return [];
    }
}

/**
 * Calcola il prezzo considerando la tratta utente, l'avvicinamento, il riposizionamento e i posti richiesti.
 */
export async function calcolaPrezzo(
    corsa, 
    postiRichiesti, 
    tipo, 
    kmUtente, 
    kmTotali, 
    totPasseggeriCorrenti = 0, 
    classe = 'STANDARD',
    kmAvvicinamento = 0,
    kmRiposizionamento = 0,
    isNuovoUtente = true
) {
    const tipoValido = ['privata', 'condivisa', 'popbus', 'pop-bus'].includes(tipo) ? tipo : 'standard';
    const postiUtente = Math.max(1, Number(postiRichiesti || 1));
    const classeKey = classe?.toUpperCase() || 'STANDARD';
    const multiplier = CLASSE_MULTIPLIER[classeKey] || 1.0;

    let prezzoCalcolato = null;
    let targetPasseggeri = 1;

    // Estrazione e normalizzazione dei chilometri operativi (Math.abs garantisce che la distanza sia sempre positiva)
    const avvicinamento = Number(kmAvvicinamento) || Number(corsa.km_avvicinamento) || 0;
    const riposizionamento = Number(kmRiposizionamento) || Number(corsa.km_riposizionamento) || 0;
    const safeKmUtente = Math.abs(Number(kmUtente) || 0);
    const safeKmTotali = Math.max(0.1, Number(kmTotali) || safeKmUtente || 1);
    const kmComplessiviOperativi = safeKmTotali + avvicinamento + riposizionamento;

    console.log(`🧮 [PRICING START] Tipo: ${tipoValido} | Posti richiesti: ${postiUtente} | Classe: ${classeKey} (Mult: ${multiplier}) | Km Utente: ${safeKmUtente} | Km Totali: ${safeKmTotali}`);

    try {
        switch (tipoValido) {
            case 'privata':
            case 'standard': {
                const info = corsa.veicolo_id ? await getTariffe(corsa.veicolo_id) : TARIFF_DEFAULT;
                const kmTotaliPrivato = safeKmUtente + avvicinamento + riposizionamento;
                prezzoCalcolato = ((info.euro_km * kmTotaliPrivato) * multiplier) * postiUtente;
                console.log(`🚗 [PRICING PRIVATA] Subtotale (per ${postiUtente} posti): ${prezzoCalcolato}`);
                break;
            }

            case 'condivisa': {
                // ... (logica condivisa invariata)
                break;
            }

            case 'popbus':
            case 'pop-bus': {
                console.log(`\n================ 🚌 [DEBUG POP-BUS PRICING INIZIO] ================`);
                let poolIds = corsa.veicoli_pool_ids;
                
                if ((!poolIds || poolIds.length === 0) && corsa.direttrice_id) {
                    console.log(`🔍 [POPBUS] Pool vuoto nell'oggetto corsa, recupero da direttrice_id: ${corsa.direttrice_id}`);
                    const { rows } = await pool.query('SELECT veicolo_id FROM direttrici_virtuali WHERE id = $1', [corsa.direttrice_id]);
                    if (rows.length > 0) poolIds = [rows[0].veicolo_id];
                }

                console.log(`📋 [POPBUS] ID veicoli nel pool da analizzare:`, poolIds);

                const poolData = await getDettaglioPool(poolIds || []);
                console.log(`📦 [POPBUS] Dettaglio grezzo estratto dal DB per i veicoli del pool:`, JSON.stringify(poolData));
                
                if (poolData.length === 0) {
                    console.log(`⚠️ [PRICING POPBUS] Nessun pool trovato o veicoli non validi per la classe ${classeKey}.`);
                    prezzoCalcolato = null;
                } else {
                    const config = CLASSI_CONFIG[classeKey] || CLASSI_CONFIG.STANDARD;
                    console.log(`⚙️ [POPBUS Config] Classe: ${classeKey} -> Soglia: ${config.soglia}, minIndice: ${config.minIndice}, maxIndice: ${config.maxIndice}`);

                    // Filtriamo i veicoli in base ai parametri della classe
                    const poolFiltrato = poolData.filter(v => v.euro_km > 0 && v.indice >= config.minIndice && v.indice <= config.maxIndice);
                    console.log(`🎯 [POPBUS] Veicoli dopo il filtraggio per indice (${classeKey}):`, JSON.stringify(poolFiltrato));
                    
                    if (poolFiltrato.length === 0) {
                        console.log(`❌ [PRICING POPBUS] Nessun veicolo idoneo dopo il filtraggio per l'indice della classe ${classeKey}.`);
                        prezzoCalcolato = null;
                        break;
                    }
                    
                    // Selezioniamo il veicolo più economico (euro_km più basso) tra quelli idonei
                    const mezzo = poolFiltrato.reduce((prev, curr) => prev.euro_km < curr.euro_km ? prev : curr);
                    console.log(`🥇 [POPBUS] Mezzo vincitore selezionato (euro_km più basso):`, mezzo);

                    // Calcolo Break-Even e target passeggeri
                    const breakEvenTotale = mezzo.euro_km * kmComplessiviOperativi;
                    targetPasseggeri = Math.max(1, Math.round(mezzo.posti * config.soglia));

                    console.log(`📊 [POPBUS Calcoli Intermedi]:`);
                    console.log(`   - Km complessivi operativi (Tratta + Avv + Rip): ${kmComplessiviOperativi}`);
                    console.log(`   - Break-Even Totale della corsa (${mezzo.euro_km} €/km * ${kmComplessiviOperativi} km): ${breakEvenTotale.toFixed(4)} €`);
                    console.log(`   - Posti totali del mezzo: ${mezzo.posti} | Soglia classe (${config.soglia * 100}%): targetPasseggeri = ${targetPasseggeri}`);

                    // Calcolo del prezzo unitario rapportato alla tratta dell'utente
                    const prezzoUnitarioPerKm = (breakEvenTotale / targetPasseggeri) * (safeKmUtente / safeKmTotali);
                    prezzoCalcolato = (prezzoUnitarioPerKm * multiplier) * postiUtente;

                    console.log(`   - Prezzo unitario proporzionale per km: ${prezzoUnitarioPerKm.toFixed(4)} €`);
                    console.log(`   - Moltiplicatore applicato (${classeKey}): ${multiplier}`);
                    console.log(`   - Posti utente richiesti: ${postiUtente}`);
                    console.log(`✨ [POPBUS] Subtotale calcolato finale: ${prezzoCalcolato.toFixed(4)} €`);
                }
                console.log(`====================================================================\n`);
                break;
            }

            default: {
                prezzoCalcolato = ((0.50 * (safeKmUtente + avvicinamento + riposizionamento)) * multiplier) * postiUtente;
                console.log(`⚠ [PRICING DEFAULT] Subtotale: ${prezzoCalcolato}`);
            }
        }
    } catch (err) {
        console.error("❌ [PRICING ERROR]", err);
        prezzoCalcolato = null;
    }

    if (prezzoCalcolato === null) {
        return null;
    }

    const finale = Math.max(PREZZO_MINIMO, Math.round(prezzoCalcolato * 100) / 100);
    console.log(`✅ [PRICING FINALE] Prezzo calcolato: ${finale} € (per ${postiUtente} posti)`);
    
    return {
        prezzo: finale,
        targetPasseggeri: targetPasseggeri
    };
}