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
        console.error(`⚠️ [PRICING] Errore DB per veicolo ${veicolo_id}:`, err);
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
 * Calcola il prezzo considerando la tratta utente, l'avvicinamento e il riposizionamento.
 * @param {Object} corsa - Dati della corsa/veicolo
 * @param {Number} postiRichiesti - Posti desiderati dall'utente
 * @param {String} tipo - Tipologia di servizio (privata, condivisa, pop-bus)
 * @param {Number} kmUtente - Km della tratta effettiva dell'utente
 * @param {Number} kmTotali - Km totali della rotta principale
 * @param {Number} totPasseggeriCorrenti - Passeggeri già a bordo
 * @param {String} classe - Classe di servizio (SAVER, STANDARD, EXPRESS)
 * @param {Number} kmAvvicinamento - Km percorsi dal deposito/veicolo per raggiungere l'utente (opzionale)
 * @param {Number} kmRiposizionamento - Km percorsi dal punto di arrivo per rientrare (opzionale)
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
    kmRiposizionamento = 0
) {
    const tipoValido = ['privata', 'condivisa', 'popbus', 'pop-bus'].includes(tipo) ? tipo : 'standard';
    const richiesti = Math.max(1, Number(postiRichiesti));
    const classeKey = classe?.toUpperCase() || 'STANDARD';
    const multiplier = CLASSE_MULTIPLIER[classeKey] || 1.0;

    let prezzoCalcolato = 0;
    let targetPasseggeri = 1;

    // Estrazione e normalizzazione dei chilometri operativi
    const avvicinamento = Number(kmAvvicinamento) || Number(corsa.km_avvicinamento) || 0;
    const riposizionamento = Number(kmRiposizionamento) || Number(corsa.km_riposizionamento) || 0;
    const safeKmUtente = Number(kmUtente) || 0;
    const safeKmTotali = Number(kmTotali) || safeKmUtente || 1;
    const kmComplessiviOperativi = safeKmTotali + avvicinamento + riposizionamento;

    console.log(`🧮 [PRICING START] Tipo: ${tipoValido} | Classe: ${classeKey} (Mult: ${multiplier}) | Km Utente: ${safeKmUtente} | Km Totali: ${safeKmTotali} | Avvicinamento: ${avvicinamento} | Riposizionamento: ${riposizionamento}`);

    try {
        switch (tipoValido) {
            case 'privata':
            case 'standard':
                const info = corsa.veicolo_id ? await getTariffe(corsa.veicolo_id) : TARIFF_DEFAULT;
                const kmTotaliPrivato = safeKmUtente + avvicinamento + riposizionamento;
                prezzoCalcolato = (info.euro_km * kmTotaliPrivato) * multiplier;
                console.log(`🚗 [PRICING PRIVATA] Veicolo ID: ${corsa.veicolo_id || 'DEFAULT'} | Tariffa €/km: ${info.euro_km} | Km Totali (Utente+Avv+Rip): ${kmTotaliPrivato} | Subtotale: ${prezzoCalcolato}`);
                break;

            case 'condivisa':
                const infoCond = corsa.veicolo_id ? await getTariffe(corsa.veicolo_id) : TARIFF_DEFAULT;
                const totPasseggeriFinale = Math.max(1, totPasseggeriCorrenti + richiesti);

                const fattoreAssorbimento = totPasseggeriCorrenti > 0 ? 0.5 : 1.0;
                const kmAvvicinamentoDinamici = avvicinamento * fattoreAssorbimento;
                const kmRiposizionamentoDinamici = riposizionamento;
                const kmVuotiResiduiTotali = kmAvvicinamentoDinamici + kmRiposizionamentoDinamici;

                const costoVuotiTotale = infoCond.euro_km * kmVuotiResiduiTotali;
                const quotaLogisticaUtente = costoVuotiTotale / totPasseggeriFinale;

                const costoTrattaUtente = infoCond.euro_km * safeKmUtente;
                const quotaTrattaPura = costoTrattaUtente + (((totPasseggeriFinale - 1) * infoCond.prezzo_passeggero) / totPasseggeriFinale);

                prezzoCalcolato = (quotaTrattaPura + quotaLogisticaUtente) * multiplier;

                console.log(`👥 [PRICING CONDIVISA DINAMICA] Km vuoti residui: ${kmVuotiResiduiTotali} | Quota Logistica: ${quotaLogisticaUtente.toFixed(2)} | Quota Tratta: ${quotaTrattaPura.toFixed(2)} | Passeggeri finali: ${totPasseggeriFinale} | Subtotale: ${prezzoCalcolato}`);
                break;

            case 'popbus':
            case 'pop-bus':
                let poolIds = corsa.veicoli_pool_ids;
                if ((!poolIds || poolIds.length === 0) && corsa.direttrice_id) {
                    const { rows } = await pool.query('SELECT veicolo_id FROM direttrici_virtuali WHERE id = $1', [corsa.direttrice_id]);
                    if (rows.length > 0) poolIds = [rows[0].veicolo_id];
                }

                const poolData = await getDettaglioPool(poolIds || []);
                
                if (poolData.length === 0) {
                    prezzoCalcolato = (TARIFF_DEFAULT.euro_km * (safeKmUtente + avvicinamento + riposizionamento)) * multiplier;
                    console.log(`🚌 [PRICING POPBUS] Nessun pool trovato, usato default. Subtotale: ${prezzoCalcolato}`);
                } else {
                    const config = CLASSI_CONFIG[classeKey] || CLASSI_CONFIG.STANDARD;
                    const poolFiltrato = poolData.filter(v => v.euro_km > 0 && v.indice >= config.minIndice && v.indice <= config.maxIndice);
                    
                    const mezzo = poolFiltrato.length > 0 
                        ? poolFiltrato.reduce((prev, curr) => prev.euro_km < curr.euro_km ? prev : curr) 
                        : poolData.reduce((prev, curr) => prev.euro_km < curr.euro_km ? prev : curr);

                    const breakEvenTotale = mezzo.euro_km * kmComplessiviOperativi;
                    targetPasseggeri = Math.max(1, Math.round(mezzo.posti * config.soglia));
                    prezzoCalcolato = ((breakEvenTotale / targetPasseggeri) * (safeKmUtente / safeKmTotali)) * multiplier;
                    
                    // --- LOG AGGIUNTIVI DI DEBUG PER EXPRESS / POPBUS ---
                    console.log(`🔍 [DEBUG POPBUS EXT] Classe: ${classeKey} | Mult: ${multiplier}`);
                    console.log(`🔍 [DEBUG POPBUS EXT] Mezzo ID: ${mezzo.id} | Euro/km: ${mezzo.euro_km} | Posti: ${mezzo.posti}`);
                    console.log(`🔍 [DEBUG POPBUS EXT] Config soglia: ${config.soglia} | Target Passeggeri: ${targetPasseggeri}`);
                    console.log(`🔍 [DEBUG POPBUS EXT] Km complessivi operativi: ${kmComplessiviOperativi} | Break-even totale: ${breakEvenTotale}`);
                    console.log(`🔍 [DEBUG POPBUS EXT] Rapporto km utente/totali: ${safeKmUtente} / ${safeKmTotali}`);
                    console.log(`🚌 [POPBUS DETTAGLIO] Scelto ID:${mezzo.id} [${classeKey}] | Subtotale calcolato: ${prezzoCalcolato}`);
                }
                break;

            default:
                prezzoCalcolato = (0.50 * (safeKmUtente + avvicinamento + riposizionamento)) * multiplier;
                console.log(`⚠️ [PRICING DEFAULT] Subtotale: ${prezzoCalcolato}`);
        }
    } catch (err) {
        console.error("❌ [PRICING ERROR]", err);
        prezzoCalcolato = (0.50 * safeKmUtente) * multiplier;
    }

    const finale = Math.max(PREZZO_MINIMO, Math.round(prezzoCalcolato * 100) / 100);
    console.log(`✅ [PRICING FINALE] Prezzo calcolato: ${finale} € (Minimo applicato se < ${PREZZO_MINIMO})`);
    
    return {
        prezzo: finale,
        targetPasseggeri: targetPasseggeri
    };
}