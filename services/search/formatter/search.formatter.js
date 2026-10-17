
import { calcolaPrezzo, ripartisciCondivisaModelloA } from '../../../utils/pricing.util.js';
import {
    getLocalitaSafe,
    getDurataDistanza
} from '../../../utils/maps.util.js';

const localitaCache = new Map();

const UI_CONFIG = {
    'pop-bus': { colore: '#FF9800' },
    'privata': { colore: '#000000' },
    'condivisa': { colore: '#4A90E2' }
};

const CLASSI_POPBUS = ['SAVER', 'STANDARD', 'EXPRESS'];

const safeDate = (dateInput) => {
    const d = new Date(dateInput);
    return !isNaN(d.getTime()) ? d : new Date();
};

const getSafeISO = (dateInput) =>
    safeDate(dateInput).toISOString();

const parseServizi = (servizi) => {
    if (!servizi) return {};
    if (typeof servizi === 'object') return servizi;

    try {
        return JSON.parse(servizi);
    } catch (e) {
        return {};
    }
};

const determinaArrivoReale = (partenzaISO, durataMinuti) => {
    try {
        const d = new Date(partenzaISO);

        if (isNaN(d.getTime())) return null;

        d.setMinutes(
            d.getMinutes() +
            Math.max(1, Math.round(durataMinuti))
        );

        return d.toISOString();
    } catch (e) {
        return null;
    }
};

async function getLocalitaSafeCached(coord) {
    if (!coord || typeof coord.lat === 'undefined') {
        return 'N/D';
    }

    const lat = Number(coord.lat);
    const lon = Number(coord.lon ?? coord.lng);

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        return 'N/D';
    }

    const key = `${lat.toFixed(3)}_${lon.toFixed(3)}`;

    if (localitaCache.has(key)) {
        return localitaCache.get(key);
    }

    const loc = await getLocalitaSafe({ lat, lon });

    if (localitaCache.size >= 1000) {
        localitaCache.clear();
    }

    localitaCache.set(key, loc);

    return loc;
}

function arrotondaPrezzo(prezzo) {
    const n = Number(prezzo);

    if (!Number.isFinite(n) || n < 0) {
        return null;
    }

    return Math.max(1, Math.ceil(n));
}

function numeroValido(value, fallback = null) {
    if (value === null || value === undefined || value === '') {
        return fallback;
    }

    const n = Number(value);

    return Number.isFinite(n) ? n : fallback;
}

function interoNonNegativo(value, fallback = null) {
    const n = numeroValido(value);

    return n !== null && Number.isInteger(n) && n >= 0
        ? n
        : fallback;
}

/**
 * Normalizza i dati prodotti da formation-preview.js.
 *
 * Attenzione:
 * - posti_in_formazione riguarda le richieste già esistenti.
 * - posti_richiesti_utente riguarda la ricerca corrente.
 * - soglia_raggiunta è riferita alla simulazione con la
 *   nuova richiesta, non a una corsa già attivata.
 */
function formattaFormazione(formazione, postiUtente, prezzoEffettivo) {
    const vuota = {
        formazione_disponibile: false,
        stato_formazione: 'non_disponibile',
        richieste_compatibili: 0,
        posti_in_formazione: 0,
        picco_occupazione: 0,
        posti_richiesti_utente: postiUtente,
        posti_mancanti_stimati: null,
        posti_mancanti_dopo_richiesta_stimati: null,
        ricavo_attuale: null,
        ricavo_con_richiesta: null,
        costo_attivazione: null,
        soglia_attivazione_lorda: null,
        commissione_turentu: null,
        ricavo_netto_con_richiesta: null,
        margine_netto_con_richiesta: null,
        ricavo_mancante: null,
        ricavo_mancante_dopo_richiesta: null,
        soglia_raggiunta: false,
        partenza_prevista_formazione: null,
        veicolo_riferimento_id: null,
        attendibilita_formazione: 'non_disponibile'
    };

    if (!formazione || formazione.stato === 'nessuna_formazione') {
        return vuota;
    }

    const ricavoAttuale = numeroValido(formazione.ricavo_attuale);
    const costoAttivazione = numeroValido(formazione.costo_attivazione);
    const sogliaLorda = numeroValido(formazione.soglia_attivazione_lorda);
    const ricavoOriginale = numeroValido(formazione.ricavo_con_richiesta);

    // La soglia lorda è calcolata da cycle-pricing.js: include commissione
    // Turentu e costo dell'intero ciclo (avvicinamento, missione, ritorno).
    // Se manca, NON sostituirla con il solo costo operativo.
    const centesimi = valore => Math.round(valore * 100);
    const euro = valore => Math.round(valore) / 100;
    const ricavoConRichiesta =
        ricavoAttuale !== null && prezzoEffettivo !== null
            ? euro(centesimi(ricavoAttuale) + centesimi(prezzoEffettivo))
            : ricavoOriginale;

    const deficit = ricavo =>
        sogliaLorda !== null && ricavo !== null
            ? Math.max(0, euro(centesimi(sogliaLorda) - centesimi(ricavo)))
            : null;

    const ricavoMancante = deficit(ricavoAttuale);
    const ricavoMancanteDopo = deficit(ricavoConRichiesta);

    const prezzoUnitario =
        prezzoEffettivo !== null && postiUtente > 0
            ? prezzoEffettivo / postiUtente
            : null;

    const stimaPosti = mancante => {
        if (mancante === null) return null;
        if (mancante <= 0) return 0;
        if (prezzoUnitario === null ||
            !Number.isFinite(prezzoUnitario) || prezzoUnitario <= 0) {
            return null;
        }
        return Math.ceil((mancante - 1e-9) / prezzoUnitario);
    };

    // L'anteprima usa la soglia lorda esatta prodotta dal motore economico.
    // Il confronto è aggiornato al prezzo effettivamente esposto al cliente.
    const sogliaRaggiunta = ricavoMancanteDopo !== null &&
        ricavoMancanteDopo === 0;

    // Ricostruzione informativa della commissione sul prezzo finale.
    // Il 15% è la commissione definita in cycle-pricing.js.
    const commissioneCentesimi = ricavoConRichiesta !== null
        ? Math.round(centesimi(ricavoConRichiesta) * 1500 / 10000)
        : null;
    const nettoCentesimi = commissioneCentesimi !== null
        ? centesimi(ricavoConRichiesta) - commissioneCentesimi
        : null;
    const margineCentesimi = nettoCentesimi !== null && costoAttivazione !== null
        ? nettoCentesimi - centesimi(costoAttivazione)
        : null;

    return {
        formazione_disponibile: true,
        stato_formazione: sogliaRaggiunta
            ? 'soglia_economica_raggiunta' : 'in_formazione',
        richieste_compatibili: interoNonNegativo(formazione.richieste_compatibili, 0),
        posti_in_formazione: interoNonNegativo(formazione.posti_in_formazione, 0),
        picco_occupazione: interoNonNegativo(formazione.picco_occupazione, 0),
        posti_richiesti_utente: postiUtente,
        posti_mancanti_stimati: stimaPosti(ricavoMancante),
        posti_mancanti_dopo_richiesta_stimati: stimaPosti(ricavoMancanteDopo),
        ricavo_attuale: ricavoAttuale,
        ricavo_con_richiesta: ricavoConRichiesta,
        costo_attivazione: costoAttivazione,
        soglia_attivazione_lorda: sogliaLorda,
        commissione_turentu: commissioneCentesimi === null ? null : euro(commissioneCentesimi),
        ricavo_netto_con_richiesta: nettoCentesimi === null ? null : euro(nettoCentesimi),
        margine_netto_con_richiesta: margineCentesimi === null ? null : euro(margineCentesimi),
        ricavo_mancante: ricavoMancante,
        ricavo_mancante_dopo_richiesta: ricavoMancanteDopo,
        soglia_raggiunta: sogliaRaggiunta,
        partenza_prevista_formazione: formazione.partenza_prevista || null,
        veicolo_riferimento_id: formazione.veicolo_riferimento_id ?? null,
        attendibilita_formazione: formazione.attendibilita || 'indicativa'
    };
}

export async function formatResults(
    richiesta,
    risultatiFiltrati
) {
    console.log(
        `🚀 [FORMAT] Inizio elaborazione di ${
            risultatiFiltrati?.length || 0
        } risultati.`
    );

    const postiUtenteRichiesti = Number(
        richiesta.posti_richiesti ||
        richiesta.posti ||
        richiesta.passeggeri ||
        richiesta.numero_passeggeri ||
        1
    );

    const buckets = {
        condivisa: [],
        privata: [],
        'pop-bus': []
    };

    (risultatiFiltrati || []).forEach(item => {
        const t = String(
            item.tipo || ''
        ).toLowerCase().trim();

        if (t === 'condivisa') {
            buckets.condivisa.push(item);
        } else if (
            t === 'privata' ||
            t === 'privato'
        ) {
            buckets.privata.push(item);
        } else if (t.includes('pop')) {
            buckets['pop-bus'].push(item);
        }
    });

    const risultatiLimitati = [
        ...buckets.condivisa.slice(0, 4),
        ...buckets.privata.slice(0, 4),
        ...buckets['pop-bus'].slice(0, 4)
    ].slice(0, 12);

    const [
        localitaOrigine,
        localitaDestinazione
    ] = await Promise.all([
        (
            typeof richiesta.localitaOrigine === 'object' &&
            richiesta.localitaOrigine?.description
        )
            ? richiesta.localitaOrigine.description
            : (
                typeof richiesta.localitaOrigine === 'string' &&
                richiesta.localitaOrigine !== 'N/D'
            )
                ? richiesta.localitaOrigine
                : getLocalitaSafeCached(richiesta.coord),

        (
            typeof richiesta.localitaDestinazione === 'object' &&
            richiesta.localitaDestinazione?.description
        )
            ? richiesta.localitaDestinazione.description
            : (
                typeof richiesta.localitaDestinazione === 'string' &&
                richiesta.localitaDestinazione !== 'N/D'
            )
                ? richiesta.localitaDestinazione
                : getLocalitaSafeCached(richiesta.coordDest)
    ]);

    const coordOrigine = richiesta.coord;
    const coordDestinazione = richiesta.coordDest;

    const mapInfo = await getDurataDistanza(
        coordOrigine,
        coordDestinazione
    );

    const distKmRichiesta =
        mapInfo.distanzaKm > 0
            ? mapInfo.distanzaKm
            : (
                Number(
                    richiesta.distanzaMetri || 1000
                ) / 1000
            );

    const distMetriRichiesta =
        distKmRichiesta * 1000;

    const durataMinutiRichiesta =
        mapInfo.durataMs > 0
            ? mapInfo.durataMs / 60000
            : Math.max(
                30,
                Math.round(distKmRichiesta)
            );

    const oraPartenzaISO = getSafeISO(
        richiesta.start_datetime || Date.now()
    );

    const oraRitornoISO =
        richiesta.return_datetime
            ? getSafeISO(richiesta.return_datetime)
            : null;

    const resultsNested = await Promise.all(
        risultatiLimitati.map(async (item) => {
            if (!item) return [];

            try {
                const t = String(
                    item.tipo || ''
                ).toLowerCase().trim();

                const tipoCoerente =
                    t.includes('pop')
                        ? 'pop-bus'
                        : t.includes('priv')
                            ? 'privata'
                            : 'condivisa';

                const itemId = String(
                    item.id || ''
                );

                const marcaVal =
                    item.marca ||
                    item.veicolo?.marca ||
                    '';

                const modelloVal =
                    item.modello ||
                    item.veicolo?.modello ||
                    '';

                let distMetriItem =
                    distMetriRichiesta;

                if (item.distanza) {
                    distMetriItem = item.distanza;
                }

                const distKmItem =
                    distMetriItem / 1000;

                const durataMinutiItem =
                    mapInfo.durataMs > 0
                        ? mapInfo.durataMs / 60000
                        : Math.max(
                            30,
                            Math.round(distKmItem)
                        );

                // -------------------------------------
                // 1. POPBUS VIRTUALE / IN FORMAZIONE
                // -------------------------------------

                if (itemId.startsWith('virtual_pop_')) {
                    console.log(
                        `🚌 [FORMAT POPBUS] Elaborazione ${itemId}`
                    );

                    const poolSicuro =
                        Array.isArray(item.veicoli_pool_ids)
                            ? item.veicoli_pool_ids
                            : [];

                    const opzioniPopBusMappe =
                        await Promise.all(
                            CLASSI_POPBUS.map(
                                async (classeCorrente) => {
                                    const kmAvv = Number(
                                        item.km_avvicinamento ??
                                        richiesta.km_avvicinamento ??
                                        0
                                    );

                                    const kmRip = Number(
                                        item.km_riposizionamento ??
                                        richiesta.km_riposizionamento ??
                                        0
                                    );

                                    const p = await calcolaPrezzo(
                                        {
                                            ...item,
                                            veicoli_pool_ids:
                                                poolSicuro
                                        },
                                        postiUtenteRichiesti,
                                        'pop-bus',
                                        distKmRichiesta,
                                        distKmRichiesta,
                                        0,
                                        classeCorrente,
                                        kmAvv,
                                        kmRip
                                    );

                                    if (!p) {
                                        console.warn(
                                            `[FORMAT POPBUS] Prezzo non disponibile per ${classeCorrente}`
                                        );
                                        return null;
                                    }

                                    const prezzoVal =
                                        arrotondaPrezzo(p.prezzo);

                                    if (prezzoVal === null) {
                                        return null;
                                    }

                                    const formazioneGrezza =
                                        item.formazioni_popbus?.[
                                            classeCorrente
                                        ] ?? null;

                                    const formazione =
                                        formattaFormazione(
                                            formazioneGrezza,
                                            postiUtenteRichiesti,
                                            prezzoVal
                                        );

                                    console.log(
                                        `📊 [FORMAT POPBUS] Classe=${classeCorrente}`,
                                        {
                                            prezzo: prezzoVal,
                                            posti_in_formazione:
                                                formazione.posti_in_formazione,
                                            posti_mancanti:
                                                formazione.posti_mancanti_stimati,
                                            posti_mancanti_dopo:
                                                formazione.posti_mancanti_dopo_richiesta_stimati,
                                            soglia_raggiunta:
                                                formazione.soglia_raggiunta
                                        }
                                    );

                                    return {
                                        id:
                                            `${itemId}_${classeCorrente.toLowerCase()}`,

                                        veicolo_id: null,
                                        operazione:
                                            'richiesta_virtuale',

                                        direttrice_id: null,
                                        corsa_id: null,

                                        tipo: 'pop-bus',

                                        // PIXEL: informazioni territoriali, non nodi_direttrice.
                                        origine_nodo_territoriale_id:
                                            item.origine_nodo_territoriale_id ?? null,
                                        destinazione_nodo_territoriale_id:
                                            item.destinazione_nodo_territoriale_id ?? null,
                                        pixel_fermate_disponibili:
                                            item.pixel_fermate_disponibili === true,
                                        pixel_stato:
                                            item.pixel_stato ?? 'non_verificato',

                                        colore_ui:
                                            UI_CONFIG['pop-bus'].colore,

                                        classe: classeCorrente,
                                        badge:
                                            `POP BUS ${classeCorrente}`,

                                        marca: marcaVal,
                                        modello: modelloVal,

                                        localitaOrigine,
                                        localitaDestinazione,

                                        oraPartenza:
                                            oraPartenzaISO,
                                        start_datetime:
                                            oraPartenzaISO,

                                        oraArrivo:
                                            determinaArrivoReale(
                                                oraPartenzaISO,
                                                durataMinutiRichiesta
                                            ),

                                        oraRitorno:
                                            oraRitornoISO,

                                        oraArrivoRitorno:
                                            oraRitornoISO
                                                ? determinaArrivoReale(
                                                    oraRitornoISO,
                                                    durataMinutiRichiesta
                                                )
                                                : null,

                                        distanza_metri:
                                            distMetriRichiesta,

                                        durata_minuti:
                                            Math.round(
                                                durataMinutiRichiesta
                                            ),

                                        prezzo: prezzoVal,
                                        prezzo_display:
                                            `${prezzoVal}€`,

                                        posti_necessari_break_even:
                                            p.targetPasseggeri || 1,

                                        messaggio:
                                            item.messaggio || null,

                                        postiDisponibili: 0,
                                        postiTotali: 0,

                                        is_pool: true,
                                        veicoli_pool_ids:
                                            poolSicuro,

                                        servizi: {},

                                        // Informazioni POPBUS V2
                                        ...formazione,

                                        anteprima_formazione:
                                            !!item.anteprima_formazione,

                                        formazione_simulata:
                                            formazione.formazione_disponibile,

                                        soglia_attivazione_confermata:
                                            false
                                    };
                                }
                            )
                        );

                    return opzioniPopBusMappe.filter(
                        opzione => opzione !== null
                    );
                }

                // -------------------------------------
                // 2. CORSE REALI
                // -------------------------------------

                const passeggeriGiaABordo = Number(
                    item.passeggeri_esistenti ||
                    item.posti_occupati ||
                    item.passeggeri_correnti ||
                    0
                );

                const kmAvvItem = Number(
                    item.km_avvicinamento ??
                    richiesta.km_avvicinamento ??
                    0
                );

                const kmRipItem = Number(
                    item.km_riposizionamento ??
                    richiesta.km_riposizionamento ??
                    0
                );

                const kmTrattaUtente = Number(
                    item.distanzaKm ||
                    item.km_utente ||
                    (
                        item.distanza
                            ? item.distanza / 1000
                            : distKmItem
                    )
                );

                const kmTotaliRotte =
                    kmTrattaUtente +
                    kmAvvItem +
                    kmRipItem;

                if (tipoCoerente === 'pop-bus') {
                    console.log(
                        `📊 [FORMAT POPBUS REALE] ID=${itemId}`,
                        {
                            kmTrattaUtente,
                            kmAvvItem,
                            kmRipItem,
                            kmTotaliRotte,
                            passeggeriGiaABordo
                        }
                    );
                }

                 // NCC condivisa: quota PROIETTATA aggiungendo il richiedente
                 // alle sole prenotazioni già confermate. Non modifica il DB.
                 let prezzoModelloA = null;
                 if (tipoCoerente === 'condivisa') {
                     const snapshot = item.modelloA;
                     if (!snapshot || !Number.isFinite(snapshot.costoCommercialeMissione) ||
                         snapshot.costoCommercialeMissione <= 0 ||
                         !Number.isFinite(snapshot.kmPrimaPrenotazione) ||
                         snapshot.kmPrimaPrenotazione <= 0 ||
                         !Number.isFinite(kmTrattaUtente) || kmTrattaUtente <= 0) {
                         console.warn(`[MODELLO A SEARCH] Corsa ${itemId} senza snapshot valido: omessa`);
                         return [];
                     }
                     const nuovoId = '__nuova_richiesta__';
                     const proiezione = ripartisciCondivisaModelloA({
                         ...snapshot,
                         prenotazioni: [
                             ...snapshot.prenotazioni,
                             { id: nuovoId, km: kmTrattaUtente, posti: postiUtenteRichiesti }
                         ]
                     });
                     prezzoModelloA = proiezione.prenotazioni.find(r => r.id === nuovoId)?.prezzoTotale;
                     if (!Number.isFinite(prezzoModelloA) || prezzoModelloA < 0.50) return [];
                 }

                const p = tipoCoerente === 'condivisa'
                     ? { prezzo: prezzoModelloA }
                     : await calcolaPrezzo(
                    item,
                    postiUtenteRichiesti,
                    tipoCoerente,
                    kmTrattaUtente,
                    kmTotaliRotte,
                    passeggeriGiaABordo,
                    item.classe || 'STANDARD',
                    kmAvvItem,
                    kmRipItem
                ).catch(err => {
                    console.error(
                        `[FORMAT] Errore pricing ID=${itemId}:`,
                        err
                    );
                    return null;
                });

                if (!p) {
                    return [];
                }

                const prezzoVal = tipoCoerente === 'condivisa'
                    ? Math.round(Number(p.prezzo) * 100) / 100
                    : arrotondaPrezzo(p.prezzo);

                if (prezzoVal === null) {
                    return [];
                }

                const oraPartenzaEffettiva =
                    item.partenza_prevista
                        ? getSafeISO(
                            item.partenza_prevista
                        )
                        : oraPartenzaISO;

                return [{
                    id:
                        itemId ||
                        `slot_${item.veicolo_id}`,

                    origine: { lat: Number(coordOrigine.lat), lon: Number(coordOrigine.lon ?? coordOrigine.lng) },
                    destinazione: { lat: Number(coordDestinazione.lat), lon: Number(coordDestinazione.lon ?? coordDestinazione.lng) },

                    veicolo_id:
                        item.veicolo_id,

                    operazione:
                        item.operazione ||
                        (
                            item.is_pool
                                ? 'richiesta_direttrice'
                                : 'pending'
                        ),

                    direttrice_id:
                        item.direttrice_id ?? null,

                    corsa_id:
                        tipoCoerente === 'condivisa' ? Number(item.id) : (item.corsa_id ?? null),

                    // NCC: conserva l'identità della tratta (andata/ritorno).
                    tratta_id: tipoCoerente === 'condivisa' ? (item.tratta_id ?? null) : null,
                    direzione: tipoCoerente === 'condivisa' ? (item.direzione ?? null) : null,

                    start_node_id:
                        item.start_node_id ?? null,

                    end_node_id:
                        item.end_node_id ?? null,

                    stato:
                        item.stato ?? null,

                    start_index_polyline:
                        item.start_index_polyline ?? null,

                    end_index_polyline:
                        item.end_index_polyline ?? null,

                    tipo: tipoCoerente,

                    colore_ui:
                        UI_CONFIG[tipoCoerente]?.colore ||
                        '#9E9E9E',

                    classe:
                        item.classe || 'STANDARD',

                    marca: marcaVal,
                    modello: modelloVal,

                    localitaOrigine,
                    localitaDestinazione,

                    oraPartenza:
                        oraPartenzaEffettiva,

                    oraArrivo:
                        determinaArrivoReale(
                            oraPartenzaEffettiva,
                            durataMinutiItem
                        ),

                    oraRitorno:
                        oraRitornoISO,

                    distanza_metri:
                        distMetriItem,

                    durata_minuti:
                        Math.round(
                            durataMinutiItem
                        ),

                    prezzo:
                        prezzoVal,

                     modello_a: tipoCoerente === 'condivisa',
                     prezzo_provvisorio: tipoCoerente === 'condivisa',
                     prezzo_display:
                         `${prezzoVal.toFixed(tipoCoerente === 'condivisa' ? 2 : 0)}€`,

                    postiDisponibili:
                        item.posti_disponibili ??
                        item.posti_totali ??
                        0,

                    postiTotali:
                        Number(
                            item.posti_totali || 8
                        ),

                    is_pool:
                        !!item.is_pool,

                    messaggio:
                        item.messaggio || null,

                    servizi:
                        parseServizi(
                            item.servizi
                        ),

                    startOffset:
                        item.startOffset ??
                        item.calculated_start_offset ??
                        null,

                    endOffset:
                        item.endOffset ??
                        item.calculated_end_offset ??
                        null
                }];
            } catch (err) {
                console.error(
                    `💥 [FORMAT] Errore su ID ${item?.id}:`,
                    err
                );

                return [];
            }
        })
    );

    return resultsNested
        .flat()
        .filter(r => r !== null);
}
