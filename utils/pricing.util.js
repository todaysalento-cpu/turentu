import { pool } from '../db/db.js';

// Default coerente con le colonne reali del DB
const TARIFF_DEFAULT = { euro_km: 0.50, prezzo_passeggero: 1.00 };
const PREZZO_MINIMO = 0.50;

// Moltiplicatori basati sulla classe di servizio
const CLASSE_MULTIPLIER = {
    EXPRESS: 1.4,
    STANDARD: 1.0,
    SAVER: 0.75
};

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
            return { 
                euro_km: Number(rows[0].euro_km), 
                prezzo_passeggero: Number(rows[0].prezzo_passeggero) 
            };
        }
        return TARIFF_DEFAULT;
    } catch (err) {
        console.error(`⚠️ [PRICING] Errore recupero tariffe per veicolo ${veicolo_id}:`, err);
        return TARIFF_DEFAULT;
    }
}

async function getDettaglioPool(veicoli_ids) {
    if (!veicoli_ids || veicoli_ids.length === 0) return [];
    
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
}

/**
 * Calcolo prezzo finale con integrazione per direttrici virtuali/proattive
 */
export async function calcolaPrezzo(corsa, postiRichiesti, tipo, kmUtente, kmTotali, totPasseggeriCorrenti = 0, classe = 'STANDARD') {
    const tipoValido = ['privata', 'condivisa', 'popbus', 'pop-bus'].includes(tipo) ? tipo : 'standard';
    const richiesti = Math.max(1, Number(postiRichiesti));
    const multiplier = CLASSE_MULTIPLIER[classe?.toUpperCase()] || 1.0;

    console.log(`💰 [PRICING] Tipo: ${tipoValido} | Classe: ${classe} | KM Utente: ${kmUtente.toFixed(2)}`);

    let prezzoCalcolato = 0;

    try {
        switch (tipoValido) {
            case 'privata':
            case 'standard':
                const info = corsa.veicolo_id ? await getTariffe(corsa.veicolo_id) : TARIFF_DEFAULT;
                prezzoCalcolato = (info.euro_km * kmUtente) * multiplier;
                break;

            case 'condivisa':
                const infoCond = corsa.veicolo_id ? await getTariffe(corsa.veicolo_id) : TARIFF_DEFAULT;
                const totPasseggeriFinale = Math.max(1, totPasseggeriCorrenti + richiesti);
                const costoBase = (infoCond.euro_km * kmTotali) + ((totPasseggeriFinale - 1) * infoCond.prezzo_passeggero);
                prezzoCalcolato = ((costoBase / totPasseggeriFinale) * (kmUtente / kmTotali)) * multiplier;
                break;

            case 'popbus':
            case 'pop-bus':
                // FIX: Recupero dinamico dei veicoli pool se non presenti in memoria (direttrici virtuali)
                let poolIds = corsa.veicoli_pool_ids;
                if ((!poolIds || poolIds.length === 0) && corsa.direttrice_id) {
                    const { rows } = await pool.query('SELECT veicolo_id FROM direttrici_virtuali WHERE id = $1', [corsa.direttrice_id]);
                    if (rows.length > 0 && rows[0].veicolo_id) poolIds = [rows[0].veicolo_id];
                }

                const poolData = await getDettaglioPool(poolIds || []);
                
                // Se non troviamo dati di pool, usiamo un default prudenziale
                if (poolData.length === 0) {
                    prezzoCalcolato = (TARIFF_DEFAULT.euro_km * kmUtente) * multiplier;
                } else {
                    const config = CLASSI_CONFIG[classe?.toUpperCase()] || CLASSI_CONFIG.STANDARD;
                    const poolFiltrato = poolData.filter(v => v.indice >= config.minIndice && v.indice <= config.maxIndice);
                    
                    const mezzo = poolFiltrato.length > 0 
                        ? poolFiltrato.reduce((prev, curr) => prev.euro_km > curr.euro_km ? prev : curr)
                        : poolData.reduce((prev, curr) => prev.euro_km > curr.euro_km ? prev : curr);

                    const breakEvenTotale = mezzo.euro_km * kmTotali;
                    const targetPasseggeri = Math.max(1, Math.round(mezzo.posti * config.soglia));
                    
                    prezzoCalcolato = ((breakEvenTotale / targetPasseggeri) * (kmUtente / kmTotali)) * multiplier;
                }
                break;

            default:
                prezzoCalcolato = (0.50 * kmUtente) * multiplier;
        }
    } catch (err) {
        console.error("❌ [PRICING] Errore critico nel calcolo prezzo:", err);
        prezzoCalcolato = (0.50 * kmUtente) * multiplier;
    }

    return Math.max(PREZZO_MINIMO, Math.round(prezzoCalcolato * 100) / 100);
}