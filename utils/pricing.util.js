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

export async function calcolaPrezzo(corsa, postiRichiesti, tipo, kmUtente, kmTotali, totPasseggeriCorrenti = 0, classe = 'STANDARD') {
    const tipoValido = ['privata', 'condivisa', 'popbus', 'pop-bus'].includes(tipo) ? tipo : 'standard';
    const richiesti = Math.max(1, Number(postiRichiesti));
    const classeKey = classe?.toUpperCase() || 'STANDARD';
    const multiplier = CLASSE_MULTIPLIER[classeKey] || 1.0;

    console.log(`🔍 [PRICING LOG] --- Inizio Calcolo ---`);
    console.log(`Tipo: ${tipoValido}, Classe: ${classeKey} (x${multiplier}), Posti: ${richiesti}`);
    console.log(`Distanze: Utente ${kmUtente}km / Totale ${kmTotali}km`);

    let prezzoCalcolato = 0;

    try {
        switch (tipoValido) {
            case 'privata':
            case 'standard':
                const info = corsa.veicolo_id ? await getTariffe(corsa.veicolo_id) : TARIFF_DEFAULT;
                prezzoCalcolato = (info.euro_km * kmUtente) * multiplier;
                console.log(`💰 [STANDARD] Base: ${info.euro_km}€/km. Calcolo: (${info.euro_km} * ${kmUtente}) * ${multiplier} = ${prezzoCalcolato.toFixed(2)}€`);
                break;

            case 'condivisa':
                const infoCond = corsa.veicolo_id ? await getTariffe(corsa.veicolo_id) : TARIFF_DEFAULT;
                const totPasseggeriFinale = Math.max(1, totPasseggeriCorrenti + richiesti);
                const costoBase = (infoCond.euro_km * kmTotali) + ((totPasseggeriFinale - 1) * infoCond.prezzo_passeggero);
                prezzoCalcolato = ((costoBase / totPasseggeriFinale) * (kmUtente / kmTotali)) * multiplier;
                console.log(`🤝 [CONDIVISA] Passeggeri finali: ${totPasseggeriFinale}, Costo Base Tot: ${costoBase.toFixed(2)}€. Risultato: ${prezzoCalcolato.toFixed(2)}€`);
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
                    prezzoCalcolato = (TARIFF_DEFAULT.euro_km * kmUtente) * multiplier;
                    console.log(`⚠️ [POPBUS] Pool vuoto, usato default.`);
                } else {
                    const config = CLASSI_CONFIG[classeKey] || CLASSI_CONFIG.STANDARD;
                    const poolFiltrato = poolData.filter(v => v.indice >= config.minIndice && v.indice <= config.maxIndice);
                    const mezzo = poolFiltrato.length > 0 ? poolFiltrato.reduce((p, c) => p.euro_km > c.euro_km ? p : c) : poolData.reduce((p, c) => p.euro_km > c.euro_km ? p : c);
                    
                    const breakEvenTotale = mezzo.euro_km * kmTotali;
                    const targetPasseggeri = Math.max(1, Math.round(mezzo.posti * config.soglia));
                    prezzoCalcolato = ((breakEvenTotale / targetPasseggeri) * (kmUtente / kmTotali)) * multiplier;
                    
                    console.log(`🚌 [POPBUS] Mezzo scelto ID: ${mezzo.id} (Indice: ${mezzo.indice.toFixed(2)}). BreakEven: ${breakEvenTotale.toFixed(2)}€, Target Passeggeri: ${targetPasseggeri}.`);
                }
                break;

            default:
                prezzoCalcolato = (0.50 * kmUtente) * multiplier;
                console.log(`⚠️ [FALLBACK] Tipo non riconosciuto, usato default.`);
        }
    } catch (err) {
        console.error("❌ [PRICING] Errore critico:", err);
        prezzoCalcolato = (0.50 * kmUtente) * multiplier;
    }

    const finale = Math.max(PREZZO_MINIMO, Math.round(prezzoCalcolato * 100) / 100);
    console.log(`✅ [PRICING] Prezzo finale applicato: ${finale}€`);
    return finale;
}