
import { pool } from '../db/db.js';

const TARIFF_DEFAULT = {
    euro_km: 0.50,
    prezzo_passeggero: 1.00
};

const PREZZO_MINIMO = 0.50;
// Commissione sul prezzo finale incassato dal cliente.
const COMMISSIONE_TURENTU = 0.15;

// Arrotondamento al centesimo superiore: il netto dell'autista
// non deve risultare inferiore al prezzo base calcolato.
const arrotondaEuroSuperiore = (value) =>
    Math.ceil(value * 100 - 1e-9) / 100;

const CLASSI_CONFIG = {
    EXPRESS: {
        soglia: 0.40,
        minIndice: 0.0,
        maxIndice: 99.0
    },
    STANDARD: {
        soglia: 0.60,
        minIndice: 0.0,
        maxIndice: 0.15
    },
    STANDARD_ALTA: {
        soglia: 0.60,
        minIndice: 0.0,
        maxIndice: 0.15
    },
    STANDARD_MEDIA: {
        soglia: 0.60,
        minIndice: 0.0,
        maxIndice: 0.15
    },
    STANDARD_BASSA: {
        soglia: 0.60,
        minIndice: 0.0,
        maxIndice: 0.15
    },
    SAVER: {
        soglia: 0.70,
        minIndice: 0.0,
        maxIndice: 0.07
    }
};

const CALCOLA_INDICE = (euro_km, posti) =>
    euro_km / Math.max(1, posti);

const arrotondaEuro = (value) =>
    Math.round((value + Number.EPSILON) * 100) / 100;

function numeroFinito(value, fallback = null) {
    if (
        value === null ||
        value === undefined ||
        value === ''
    ) {
        return fallback;
    }

    const n = Number(value);

    return Number.isFinite(n) ? n : fallback;
}

function kmNonNegativi(value, fallback = 0) {
    const n = numeroFinito(value, fallback);

    return n !== null && n >= 0 ? n : fallback;
}

function risolviKm(esplicito, daCorsa) {
    return kmNonNegativi(
        esplicito ?? daCorsa,
        0
    );
}

function normalizzaClasse(classe) {
    const raw = String(classe || 'STANDARD').trim().toUpperCase();
    const key = raw.endsWith('_V2') ? raw.slice(0, -3) : raw;
    // Le classi STANDARD_ALTA / MEDIA / BASSA restano distinte.
    return Object.hasOwn(CLASSI_CONFIG, key) ? key : 'STANDARD';
}

function dettagliDefault() {
    return {
        costoMissione: null,
        costoCommercialeMissione: null,
        postiTotaliMissione: null,
        prezzoUnitario: null,
        prezzoUnitarioCommerciale: null,
        veicoloRiferimentoId: null,
        tariffaKm: null,
        kmComplessiviOperativi: null,
        sogliaPercentuale: null,
        indiceEfficienza: null,
        veicoliIdonei: 0,
        veicoliCapienti: 0,
        criterioSelezione: null,
        avvisoCapienza: null,
        prezzoBase: null,
        commissionePercentuale: null,
        commissioneImporto: null,
        compensoAutista: null,
        prezzoCommerciale: null
    };
}

/**
 * Recupera la tariffa di un singolo veicolo.
 *
 * Mantiene il fallback storico per non interrompere
 * le corse private già gestite dal sistema.
 */
export async function getTariffe(veicolo_id) {
    try {
        const { rows } = await pool.query(
            `
            SELECT
                euro_km,
                prezzo_passeggero
            FROM tariffe
            WHERE veicolo_id = $1
              AND euro_km > 0
            ORDER BY
                (tipo = 'standard') DESC
            LIMIT 1
            `,
            [veicolo_id]
        );

        if (rows[0]) {
            return {
                euro_km: Number(rows[0].euro_km),
                prezzo_passeggero: Number(
                    rows[0].prezzo_passeggero
                )
            };
        }

        return { ...TARIFF_DEFAULT };

    } catch (err) {
        console.error(
            `⚠ [PRICING] Errore DB per veicolo ${veicolo_id}:`,
            err
        );

        return { ...TARIFF_DEFAULT };
    }
}

/**
 * Recupera i veicoli del pool con tariffa valida.
 *
 * La preferenza per la tariffa standard è coerente
 * con la logica precedente.
 */
async function getDettaglioPool(veicoli_ids) {
    if (
        !Array.isArray(veicoli_ids) ||
        veicoli_ids.length === 0
    ) {
        return [];
    }

    const ids = [
        ...new Set(
            veicoli_ids
                .map(Number)
                .filter(
                    id =>
                        Number.isInteger(id) &&
                        id > 0
                )
        )
    ];

    if (ids.length === 0) {
        return [];
    }

    try {
        const { rows } = await pool.query(
            `
            SELECT DISTINCT ON (t.veicolo_id)
                t.veicolo_id,
                t.euro_km,
                v.posti_totali AS posti
            FROM tariffe t
            JOIN veicolo v
                ON t.veicolo_id = v.id
            WHERE t.veicolo_id = ANY($1::int[])
              AND t.euro_km > 0
              AND v.posti_totali > 0
            ORDER BY
                t.veicolo_id,
                (t.tipo = 'standard') DESC,
                t.euro_km ASC
            `,
            [ids]
        );

        return rows.map(r => {
            const euro_km = Number(r.euro_km);
            const posti = Number(r.posti);

            return {
                id: Number(r.veicolo_id),
                euro_km,
                posti,
                indice: CALCOLA_INDICE(
                    euro_km,
                    posti
                )
            };
        }).filter(v =>
            Number.isFinite(v.euro_km) &&
            v.euro_km > 0 &&
            Number.isInteger(v.posti) &&
            v.posti > 0
        );

    } catch (err) {
        console.error(
            '❌ [POOL] Errore query pool:',
            err
        );

        return [];
    }
}

/**
 * Calcola il prezzo di una corsa.
 *
 * Compatibilità:
 * - Mantiene la firma originale.
 * - Mantiene prezzo e targetPasseggeri.
 * - Aggiunge dettagli economici informativi.
 *
 * IMPORTANTE:
 * Il ritorno alla base fa parte del costo
 * della missione e della soglia di attivazione.
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
    const tipoValido = [
        'privata',
        'condivisa',
        'popbus',
        'pop-bus'
    ].includes(tipo)
        ? tipo
        : 'standard';

    const postiUtente = Number(postiRichiesti || 1);
    if (!Number.isInteger(postiUtente) || postiUtente <= 0) {
        console.warn('[PRICING] Numero posti non valido:', postiRichiesti);
        return null;
    }

    const classeKey = normalizzaClasse(classe);

    const avvicinamento = risolviKm(
        kmAvvicinamento,
        corsa?.km_avvicinamento
    );

    const riposizionamento = risolviKm(
        kmRiposizionamento,
        corsa?.km_riposizionamento
    );

    const safeKmUtente = Math.abs(
        numeroFinito(kmUtente, 0)
    );

    // Il costo operativo comprende sempre:
    // tratta + avvicinamento + ritorno alla base.
    //
    // kmTotali è mantenuto nella firma per
    // compatibilità con i chiamanti esistenti.
    const kmComplessiviOperativi =
        safeKmUtente +
        avvicinamento +
        riposizionamento;

    let prezzoCalcolato = null;
    let targetPasseggeri = 1;

    const dettagli = dettagliDefault();

    dettagli.kmComplessiviOperativi =
        kmComplessiviOperativi;

    console.log(
        `🧮 [PRICING START] ` +
        `Tipo=${tipoValido} | ` +
        `Posti=${postiUtente} | ` +
        `Classe=${classeKey} | ` +
        `Km utente=${safeKmUtente} | ` +
        `Km operativi=${kmComplessiviOperativi}`
    );

    try {
        switch (tipoValido) {

            // ---------------------------------
            // 1. CORSA PRIVATA
            // ---------------------------------
            case 'privata':
            case 'standard': {
                const info = corsa?.veicolo_id
                    ? await getTariffe(
                        corsa.veicolo_id
                    )
                    : TARIFF_DEFAULT;

                prezzoCalcolato =
                    (
                        info.euro_km *
                        kmComplessiviOperativi
                    ) *
                    postiUtente;

                console.log(
                    `🚗 [PRICING PRIVATA] ` +
                    `Prezzo=${prezzoCalcolato}`
                );

                break;
            }

            // ---------------------------------
            // 2. CORSA CONDIVISA
            // ---------------------------------
            case 'condivisa': {
                const info = corsa?.veicolo_id
                    ? await getTariffe(
                        corsa.veicolo_id
                    )
                    : null;

                if (!info) {
                    return null;
                }

                const gia = Math.max(
                    0,
                    Number(
                        totPasseggeriCorrenti
                    ) || 0
                );

                const totale =
                    gia + postiUtente;

                const primo = Math.max(
                    1,
                    Number(
                        corsa.primo_posto
                    ) || 1
                );

                prezzoCalcolato = (
                    (
                        info.euro_km *
                        kmComplessiviOperativi
                    ) +
                    (
                        Math.max(
                            0,
                            totale - primo
                        ) *
                        info.prezzo_passeggero
                    )
                ) / totale * postiUtente;

                console.log(
                    `🚐 [PRICING CONDIVISA] ` +
                    `Passeggeri esistenti=${gia} | ` +
                    `Totale=${totale} | ` +
                    `Prezzo=${prezzoCalcolato}`
                );

                break;
            }

            // ---------------------------------
            // 3. POPBUS V2
            // ---------------------------------
            case 'popbus':
            case 'pop-bus': {

                console.log(
                    '\n========== 🚌 POPBUS PRICING V2 MULTI-VEICOLO =========='
                );
                if (kmComplessiviOperativi <= 0) {
                    console.warn('[POPBUS] Distanza operativa non valida');
                    prezzoCalcolato = null;
                    break;
                }

                let poolIds = Array.isArray(
                    corsa?.veicoli_pool_ids
                )
                    ? corsa.veicoli_pool_ids
                    : [];

                let classeEfficace =
                    classeKey;

                // Se la direttrice è già presente,
                // recuperiamo classe e veicolo.
                if (corsa?.direttrice_id) {
                    const { rows: dirRows } =
                        await pool.query(
                            `
                            SELECT
                                tipo_servizio,
                                veicolo_id
                            FROM direttrici_virtuali
                            WHERE id = $1
                            `,
                            [corsa.direttrice_id]
                        );

                    if (dirRows.length > 0) {
                        const dir = dirRows[0];

                        if (dir.tipo_servizio) {
                            classeEfficace =
                                normalizzaClasse(
                                    dir.tipo_servizio
                                );
                        }

                        if (
                            poolIds.length === 0 &&
                            dir.veicolo_id
                        ) {
                            poolIds = [
                                dir.veicolo_id
                            ];
                        }
                    }
                }

                console.log(
                    '[POPBUS] Classe:',
                    classeEfficace
                );

                console.log(
                    '[POPBUS] Veicoli pool:',
                    poolIds
                );

                const poolData =
                    await getDettaglioPool(
                        poolIds
                    );

                if (poolData.length === 0) {
                    console.warn(
                        '[POPBUS] Nessun veicolo con tariffa valida'
                    );

                    prezzoCalcolato = null;
                    break;
                }

                const config =
                    CLASSI_CONFIG[classeEfficace] ||
                    CLASSI_CONFIG.STANDARD;

                // L'indice filtra l'idoneità commerciale della classe.
                // La capienza è invece fisica: mai moltiplicarla per due.
                const poolFiltrato = poolData.filter(v =>
                    v.euro_km > 0 &&
                    v.indice >= config.minIndice &&
                    v.indice <= config.maxIndice
                );

                dettagli.veicoliIdonei = poolFiltrato.length;

                const poolCapiente = poolFiltrato.filter(v =>
                    v.posti >= postiUtente
                );
                dettagli.veicoliCapienti = poolCapiente.length;

                if (!poolCapiente.length) {
                    console.warn('[POPBUS] Nessun mezzo capiente per la richiesta', {
                        classe: classeEfficace,
                        postiRichiesti: postiUtente,
                        veicoliIdonei: poolFiltrato.length
                    });
                    prezzoCalcolato = null;
                    break;
                }

                // Nel pool multi-veicolo il riferimento per il prezzo
                // è il veicolo capiente dal minor costo operativo stimato,
                // non quello con indice €/km/posto più basso.
                // Questo NON riserva il mezzo e NON garantisce disponibilità.
                const mezzo = [...poolCapiente].sort((a, b) =>
                    a.euro_km - b.euro_km ||
                    a.indice - b.indice ||
                    a.id - b.id
                )[0];

                dettagli.criterioSelezione = 'minor_costo_km_tra_veicoli_capienti';
                dettagli.avvisoCapienza =
                    'Capienza verificata sulla singola richiesta; disponibilità, percorso e assegnazione verificati dal matching.';

                const breakEvenTotale =
                    mezzo.euro_km *
                    kmComplessiviOperativi;

                // Modello commerciale A/R:
                // posti del veicolo moltiplicati
                // per due e soglia della classe.
                const postiTotaliMissione =
                    mezzo.posti * 2;

                const targetTeorico = Math.max(
                    1,
                    Math.round(postiTotaliMissione * config.soglia)
                );

                // Il target economico non può eccedere i posti fisici
                // per una formazione sulla stessa tratta/segmento.
                // Se le tratte non si sovrappongono, il matching potrà
                // sfruttare il ricambio dei posti sui singoli segmenti.
                targetPasseggeri = Math.min(mezzo.posti, targetTeorico);

                const prezzoUnitario =
                    breakEvenTotale /
                    targetPasseggeri;

                prezzoCalcolato =
                    prezzoUnitario *
                    postiUtente;

                // Dati informativi aggiuntivi
                dettagli.costoMissione =
                    arrotondaEuro(
                        breakEvenTotale
                    );

                dettagli.postiTotaliMissione =
                    postiTotaliMissione;

                dettagli.prezzoUnitario =
                    arrotondaEuro(
                        prezzoUnitario
                    );

                dettagli.veicoloRiferimentoId =
                    mezzo.id;

                dettagli.tariffaKm =
                    mezzo.euro_km;

                dettagli.sogliaPercentuale =
                    config.soglia;

                dettagli.indiceEfficienza =
                    mezzo.indice;

                console.log(
                    '[POPBUS] Riepilogo:',
                    {
                        classe: classeEfficace,
                        veicolo_id: mezzo.id,
                        tariffa_km:
                            mezzo.euro_km,
                        indice:
                            mezzo.indice,
                        km_operativi:
                            kmComplessiviOperativi,
                        costo_missione:
                            breakEvenTotale,
                        posti_totali_missione:
                            postiTotaliMissione,
                        soglia:
                            config.soglia,
                        target_passeggeri:
                            targetPasseggeri,
                        target_teorico_ar: targetTeorico,
                        posti_fisici_veicolo: mezzo.posti,
                        veicoli_capienti: poolCapiente.length,
                        prezzo_unitario:
                            prezzoUnitario,
                        posti_richiesti:
                            postiUtente,
                        prezzo_totale:
                            prezzoCalcolato
                    }
                );

                console.log(
                    '========================================\n'
                );

                break;
            }

            // ---------------------------------
            // 4. FALLBACK
            // ---------------------------------
            default: {
                prezzoCalcolato =
                    0.50 *
                    kmComplessiviOperativi *
                    postiUtente;

                console.warn(
                    '[PRICING DEFAULT] Tipo non riconosciuto'
                );

                break;
            }
        }

    } catch (err) {
        console.error(
            '❌ [PRICING ERROR]',
            err
        );

        prezzoCalcolato = null;
    }

    if (
        prezzoCalcolato === null ||
        !Number.isFinite(
            prezzoCalcolato
        ) ||
        prezzoCalcolato < 0
    ) {
        return null;
    }

    // Il prezzo calcolato dai singoli rami e' il compenso base.
    // La commissione e' trattenuta sul prezzo finale, non aggiunta
    // con una semplice moltiplicazione per 1.15.
    const prezzoBase = Math.max(PREZZO_MINIMO, arrotondaEuro(prezzoCalcolato));
    const finale = arrotondaEuroSuperiore(
        prezzoBase / (1 - COMMISSIONE_TURENTU)
    );
    const commissioneImporto = arrotondaEuro(
        finale * COMMISSIONE_TURENTU
    );
    const compensoAutista = arrotondaEuro(
        finale - commissioneImporto
    );

    dettagli.prezzoBase = prezzoBase;
    dettagli.commissionePercentuale = COMMISSIONE_TURENTU * 100;
    dettagli.commissioneImporto = commissioneImporto;
    dettagli.compensoAutista = compensoAutista;
    dettagli.prezzoCommerciale = finale;

    // Campi POPBUS: i valori storici restano basi pre-commissione.
    if (dettagli.costoMissione !== null) {
        dettagli.costoCommercialeMissione = arrotondaEuroSuperiore(
            dettagli.costoMissione / (1 - COMMISSIONE_TURENTU)
        );
    }
    if (dettagli.prezzoUnitario !== null) {
        dettagli.prezzoUnitarioCommerciale = arrotondaEuroSuperiore(
            dettagli.prezzoUnitario / (1 - COMMISSIONE_TURENTU)
        );
    }

    console.log(
        `✅ [PRICING FINALE] ` +
        `Tipo=${tipoValido} | ` +
        `Classe=${classeKey} | ` +
        `Prezzo=${finale} € | ` +
        `Target=${targetPasseggeri}`
    );

    return {
        // Campi storici: invariati
        prezzo: finale,
        targetPasseggeri,

        // Nuovi campi informativi
        ...dettagli
    };
}
