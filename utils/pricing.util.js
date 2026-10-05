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
    kmRiposizionamento = 0
) {
    const tipoValido = ['privata', 'condivisa', 'popbus', 'pop-bus'].includes(tipo) ? tipo : 'standard';
    const postiUtente = Math.max(1, Number(postiRichiesti || 1));
    const classeKey = classe?.toUpperCase() || 'STANDARD';
    const multiplier = CLASSE_MULTIPLIER[classeKey] || 1.0;

    let prezzoCalcolato = null;
    let targetPasseggeri = 1;

    // Estrazione e normalizzazione dei chilometri operativi
    const avvicinamento = Number(kmAvvicinamento) || Number(corsa.km_avvicinamento) || 0;
    const riposizionamento = Number(kmRiposizionamento) || Number(corsa.km_riposizionamento) || 0;
    const safeKmUtente = Number(kmUtente) || 0;
    const safeKmTotali = Number(kmTotali) || safeKmUtente || 1;
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
                const infoCond = corsa.veicolo_id ? await getTariffe(corsa.veicolo_id) : TARIFF_DEFAULT;
                
                // 1. I km della corsa originale e i km di servizio (avvicinamento/riposizionamento) appartengono alla missione base
                const kmTotaliCorsaOriginale = Number(corsa.km_totali_percorso) || Number(kmTotali) || safeKmUtente;
                
                // Il costo base della missione dell'autista include la corsa originale + avvicinamento + riposizionamento fissi
                const costoMissioneAutista = infoCond.euro_km * (kmTotaliCorsaOriginale + avvicinamento + riposizionamento);

                // 2. Percentuale della tratta del nuovo utente rispetto alla corsa originale
                const percentualeUtente = Math.min(1.0, Math.max(0.0, safeKmUtente / kmTotaliCorsaOriginale));
                const contributoUtentePesarato = percentualeUtente * postiUtente;

                // 3. Recupero corretto delle percentuali dei passeggeri già presenti (allineato con il filtro disponibilità)
                let percentualiEsistenti = corsa.percentuali_passeggeri_esistenti || corsa.percentuali_passeggeri_attivi;
                const passeggeriGiaPresenti = Number(totPasseggeriCorrenti || corsa.passeggeri_esistenti || corsa.posti_occupati || 0);
                
                if (!percentualiEsistenti || !Array.isArray(percentualiEsistenti) || percentualiEsistenti.length === 0) {
                    percentualiEsistenti = passeggeriGiaPresenti > 0 ? Array(passeggeriGiaPresenti).fill(1.0) : [1.0];
                }

                const sommaPercentualiEsistenti = percentualiEsistenti.reduce((acc, curr) => acc + curr, 0);
                const sommaPercentualiTotale = sommaPercentualiEsistenti + contributoUtentePesarato;

                // 4. Ripartizione proporzionale del costo missione totale (SENZA applicare il moltiplicatore di classe)
                const quotaProporzionale = sommaPercentualiTotale > 0 ? (contributoUtentePesarato / sommaPercentualiTotale) : 1.0;
                prezzoCalcolato = costoMissioneAutista * quotaProporzionale;

                // --- 🔍 LOG DETTAGLIATI SPECIFICI PER CORSE CONDIVISE ---
                console.log(`\n================ 👥 [DEBUG DETTAGLIATO PRICING CONDIVISA] ================`);
                console.log(`🆔 Veicolo ID: ${corsa.veicolo_id || 'DEFAULT'} | Tariffa €/km: ${infoCond.euro_km}`);
                console.log(`📏 Km Tratta Utente: ${safeKmUtente} km | Km Totali Corsa Originale: ${kmTotaliCorsaOriginale} km`);
                console.log(`📊 Rapporto Tratta Utente / Corsa (Percentuale pura): ${(percentualeUtente * 100).toFixed(2)}%`);
                console.log(`🚗 Km Avvicinamento Fissi: ${avvicinamento} km | 🔄 Km Riposizionamento Fissi: ${riposizionamento} km`);
                console.log(`💰 Costo Totale Missione Autista (Fisso): ${costoMissioneAutista.toFixed(4)} € (euro_km * [KmCorsa + Avv + Rip])`);
                console.log(`👥 Array Percentuali Passeggeri Esistenti:`, percentualiEsistenti);
                console.log(`➕ Somma Percentuali Esistenti: ${sommaPercentualiEsistenti.toFixed(4)}`);
                console.log(`🧑‍🤝‍🧑 Posti richiesti dall'utente: ${postiUtente} -> Contributo ponderato utente: ${contributoUtentePesarato.toFixed(4)}`);
                console.log(`Σ Somma Percentuali Totale (Esistenti + Nuovo Utente): ${sommaPercentualiTotale.toFixed(4)}`);
                console.log(`⚖ Quota Proporzionale spettante (${contributoUtentePesarato.toFixed(4)} / ${sommaPercentualiTotale.toFixed(4)}): ${(quotaProporzionale * 100).toFixed(4)}%`);
                console.log(`✨ Moltiplicatore Classe: ESCLUSO PER LE CORSE CONDIVISE`);
                console.log(`🧮 Subtotale Finale Condivisa (Costo Missione * Quota): ${prezzoCalcolato.toFixed(4)} €`);
                console.log(`==========================================================================\n`);
                
                break;
            }

            case 'popbus':
            case 'pop-bus': {
                let poolIds = corsa.veicoli_pool_ids;
                if ((!poolIds || poolIds.length === 0) && corsa.direttrice_id) {
                    const { rows } = await pool.query('SELECT veicolo_id FROM direttrici_virtuali WHERE id = $1', [corsa.direttrice_id]);
                    if (rows.length > 0) poolIds = [rows[0].veicolo_id];
                }

                const poolData = await getDettaglioPool(poolIds || []);
                
                if (poolData.length === 0) {
                    console.log(`🚌 [PRICING POPBUS] Nessun pool trovato per la classe ${classeKey}.`);
                    prezzoCalcolato = null;
                } else {
                    const config = CLASSI_CONFIG[classeKey] || CLASSI_CONFIG.STANDARD;
                    
                    const poolFiltrato = poolData.filter(v => v.euro_km > 0 && v.indice >= config.minIndice && v.indice <= config.maxIndice);
                    
                    if (poolFiltrato.length === 0) {
                        console.log(`⚠ [PRICING POPBUS] Nessun veicolo idoneo per l'indice della classe ${classeKey}.`);
                        prezzoCalcolato = null;
                        break;
                    }
                    
                    const mezzo = poolFiltrato.reduce((prev, curr) => prev.euro_km < curr.euro_km ? prev : curr);

                    const breakEvenTotale = mezzo.euro_km * kmComplessiviOperativi;
                    targetPasseggeri = Math.max(1, Math.round(mezzo.posti * config.soglia));
                    
                    const prezzoUnitarioPerKm = (breakEvenTotale / targetPasseggeri) * (safeKmUtente / safeKmTotali);
                    prezzoCalcolato = (prezzoUnitarioPerKm * multiplier) * postiUtente;
                    
                    console.log(`🚌 [POPBUS DETTAGLIO] Scelto ID:${mezzo.id} [${classeKey}] | Posti utente: ${postiUtente} | Subtotale: ${prezzoCalcolato}`);
                }
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