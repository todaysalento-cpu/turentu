import { calcolaPrezzo } from '../../../utils/pricing.util.js';
import { getLocalitaSafe, getDurataDistanza } from '../../../utils/maps.util.js';

const localitaCache = new Map();

const UI_CONFIG = {
    'pop-bus': { colore: '#FF9800' },
    'privata': { colore: '#000000' },
    'condivisa': { colore: '#4A90E2' }
};

const safeDate = (dateInput) => {
    const d = new Date(dateInput);
    return !isNaN(d.getTime()) ? d : new Date();
};

const getSafeISO = (dateInput) => safeDate(dateInput).toISOString();

const parseServizi = (servizi) => {
    if (!servizi) return {};
    if (typeof servizi === 'object') return servizi;
    try { return JSON.parse(servizi); } catch (e) { return {}; }
};

const determinaArrivoReale = (partenzaISO, durataMinuti) => {
    try {
        const d = new Date(partenzaISO);
        if (isNaN(d.getTime())) return null;

        d.setMinutes(d.getMinutes() + Math.max(1, Math.round(durataMinuti)));
        return d.toISOString();
    } catch (e) {
        return null;
    }
};

async function getLocalitaSafeCached(coord) {
    if (!coord || typeof coord.lat === 'undefined') return "N/D";
    const key = `${coord.lat.toFixed(3)}_${coord.lon.toFixed(3)}`;
    if (localitaCache.has(key)) return localitaCache.get(key);
    const loc = await getLocalitaSafe(coord);
    localitaCache.set(key, loc);
    return loc;
}

export async function formatResults(richiesta, risultatiFiltrati) {
    console.log(`🚀 [FORMAT] Inizio elaborazione di ${risultatiFiltrati?.length || 0} risultati.`);

    const postiUtenteRichiesti = Number(
        richiesta.posti_richiesti || 
        richiesta.posti || 
        richiesta.passeggeri || 
        richiesta.numero_passeggeri || 
        1
    );

    const buckets = { condivisa: [], privata: [], 'pop-bus': [] };
    
    risultatiFiltrati.forEach(item => {
        const t = String(item.tipo || "").toLowerCase().trim();
        if (t === 'condivisa') {
            buckets.condivisa.push(item);
        } else if (t === 'privata' || t === 'privato') {
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

    const [localitaOrigine, localitaDestinazione] = await Promise.all([
        (typeof richiesta.localitaOrigine === 'object' && richiesta.localitaOrigine?.description)
            ? richiesta.localitaOrigine.description
            : ((typeof richiesta.localitaOrigine === 'string' && richiesta.localitaOrigine !== "N/D") 
                ? richiesta.localitaOrigine 
                : getLocalitaSafeCached(richiesta.coord)),
        (typeof richiesta.localitaDestinazione === 'object' && richiesta.localitaDestinazione?.description)
            ? richiesta.localitaDestinazione.description
            : ((typeof richiesta.localitaDestinazione === 'string' && richiesta.localitaDestinazione !== "N/D") 
                ? richiesta.localitaDestinazione 
                : getLocalitaSafeCached(richiesta.coordDest))
    ]);

    const coordOrigine = richiesta.coord;
    const coordDestinazione = richiesta.coordDest;
    const mapInfo = await getDurataDistanza(coordOrigine, coordDestinazione);

    const distKmRichiesta = mapInfo.distanzaKm > 0 ? mapInfo.distanzaKm : (Number(richiesta.distanzaMetri || 1000) / 1000);
    const distMetriRichiesta = distKmRichiesta * 1000;
    const durataMinutiRichiesta = mapInfo.durataMs > 0 ? (mapInfo.durataMs / 60000) : Math.max(30, Math.round(distKmRichiesta / 1.0));

    const oraPartenzaISO = getSafeISO(richiesta.start_datetime || Date.now());
    const oraRitornoISO = richiesta.return_datetime ? getSafeISO(richiesta.return_datetime) : null;

    const resultsNested = await Promise.all(risultatiLimitati.map(async (item) => {
        if (!item) return [];
        try {
            const t = String(item.tipo || "").toLowerCase().trim();
            const tipoCoerente = t.includes('pop') ? 'pop-bus' : (t.includes('priv') ? 'privata' : 'condivisa');
            const itemId = String(item.id || "");

            const marcaVal = item.marca || item.veicolo?.marca || '';
            const modelloVal = item.modello || item.veicolo?.modello || '';

            let distMetriItem = distMetriRichiesta;
            if (item.distanza) {
                distMetriItem = item.distanza;
            }
            const distKmItem = distMetriItem / 1000;
            const durataMinutiItem = mapInfo.durataMs > 0 ? (mapInfo.durataMs / 60000) : Math.max(30, Math.round(distKmItem / 1.0));

            // 1. LOGICA VIRTUAL / PENDING (POP-BUS PENDING / PROATTIVO)
            if (itemId.startsWith('virtual_pop_')) {
                console.log(`📊 [DEBUG BREAK-EVEN VIRTUAL] Analisi direttrice virtuale ID: ${itemId}`);
                console.log(`👉 [DEBUG BREAK-EVEN VIRTUAL] Posti utente richiesti: ${postiUtenteRichiesti}, Distanza Km: ${distKmRichiesta}`);

                const poolSicuro = (item.veicoli_pool_ids && item.veicoli_pool_ids.length > 0) ? item.veicoli_pool_ids : [];
                const classiDisponibili = ['SAVER', 'STANDARD', 'EXPRESS'];

                const opzioniPopBusMappe = await Promise.all(classiDisponibili.map(async (classeCorrente) => {
                    const kmAvv = Number(item.km_avvicinamento || richiesta.km_avvicinamento || 0);
                    const kmRip = Number(item.km_riposizionamento || richiesta.km_riposizionamento || 0);

                    console.log(`🔎 [DEBUG BREAK-EVEN VIRTUAL] Calcolo prezzo per Classe: ${classeCorrente} | Pool ID:`, poolSicuro, `| kmAvv: ${kmAvv}, kmRip: ${kmRip}`);

                    const p = await calcolaPrezzo(
                        { ...item, veicoli_pool_ids: poolSicuro }, 
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
                        console.warn(`⚠️ [DEBUG BREAK-EVEN VIRTUAL] calcolaPrezzo ha restituito null per la classe ${classeCorrente}`);
                        return null;
                    }

                    console.log(`✅ [DEBUG BREAK-EVEN VIRTUAL] Risultato calcolaPrezzo (${classeCorrente}):`, {
                        prezzo: p.prezzo,
                        'targetPasseggeri (Break-Even)': p.targetPasseggeri,
                        dettagliGrezzi: p
                    });

                    const prezzoVal = Math.max(1, Math.ceil(Number(p.prezzo) || 5));

                    return {
                        id: `${itemId}_${classeCorrente.toLowerCase()}`,
                        veicolo_id: null,
                        tipo: 'pop-bus',
                        colore_ui: UI_CONFIG['pop-bus'].colore,
                        classe: classeCorrente,
                        badge: `POP BUS ${classeCorrente}`,
                        marca: marcaVal,
                        modello: modelloVal,
                        localitaOrigine,
                        localitaDestinazione,
                        oraPartenza: oraPartenzaISO,
                        oraArrivo: determinaArrivoReale(oraPartenzaISO, durataMinutiRichiesta),
                        oraRitorno: oraRitornoISO,
                        oraArrivoRitorno: oraRitornoISO ? determinaArrivoReale(oraRitornoISO, durataMinutiRichiesta) : null,
                        distanza_metri: distMetriRichiesta,
                        durata_minuti: Math.round(durataMinutiRichiesta),
                        prezzo: prezzoVal,
                        prezzo_display: `${prezzoVal}€`,
                        posti_necessari_break_even: p.targetPasseggeri || 1,
                        messaggio: item.messaggio || null,
                        postiDisponibili: 0,
                        postiTotali: 0,
                        is_pool: true,
                        veicoli_pool_ids: poolSicuro,
                        servizi: {}
                    };
                }));

                return opzioniPopBusMappe.filter(opzione => opzione !== null);
            }

            // 2. LOGICA STANDARD (Corse reali trovate, inclusi Pop-Bus attivi)
            const passeggeriGiaA1Bordo = Number(item.passeggeri_esistenti || item.posti_occupati || item.passeggeri_correnti || 0);

            const kmAvvItem = Number(item.km_avvicinamento ?? richiesta.km_avvicinamento ?? 0);
            const kmRipItem = Number(item.km_riposizionamento ?? richiesta.km_riposizionamento ?? 0);
            
            const kmTrattaUtente = Number(item.distanzaKm || item.km_utente || (item.distanza ? item.distanza / 1000 : distKmItem)); 
            
            // 👈 Forziamo la somma operativa esatta (Tratta + Avv + Rip) ed evitiamo l'eredità della direttrice globale
            const kmTotaliRotte = kmTrattaUtente + kmAvvItem + kmRipItem;

            if (tipoCoerente === 'pop-bus') {
                console.log(`📊 [DEBUG BREAK-EVEN REAL] Analisi Pop-Bus reale ID: ${itemId}`);
                console.log(`👉 [DEBUG BREAK-EVEN REAL] Parametri: postiUtente=${postiUtenteRichiesti}, kmTratta=${kmTrattaUtente}, kmTotali=${kmTotaliRotte}, passeggeriA1Bordo=${passeggeriGiaA1Bordo}, classe=${item.classe || 'STANDARD'}`);
            }

            const p = await calcolaPrezzo(
                item, 
                postiUtenteRichiesti, 
                tipoCoerente, 
                kmTrattaUtente, 
                kmTotaliRotte, 
                passeggeriGiaA1Bordo, 
                item.classe || 'STANDARD',
                kmAvvItem,
                kmRipItem
            ).catch((err) => {
                if (tipoCoerente === 'pop-bus') {
                    console.error(`💥 [DEBUG BREAK-EVEN REAL] Errore in calcolaPrezzo per pop-bus reale:`, err);
                }
                return ({ prezzo: kmTrattaUtente * 0.50 });
            });
            
            if (!p) {
                if (tipoCoerente === 'pop-bus') {
                    console.warn(`⚠️ [DEBUG BREAK-EVEN REAL] calcolaPrezzo ha restituito null per pop-bus reale ID: ${itemId}`);
                }
                return [];
            }

            if (tipoCoerente === 'pop-bus') {
                console.log(`✅ [DEBUG BREAK-EVEN REAL] Risultato calcolaPrezzo (Pop-Bus reale):`, {
                    prezzo: p.prezzo,
                    'targetPasseggeri (Break-Even)': p.targetPasseggeri,
                    dettagliGrezzi: p
                });
            }

            const prezzoVal = Math.max(1, Math.ceil(Number(p.prezzo) || 1));
            const oraPartenzaEffettiva = item.partenza_prevista ? getSafeISO(item.partenza_prevista) : oraPartenzaISO;

            return [{
                id: itemId || `slot_${item.veicolo_id}`,
                veicolo_id: item.veicolo_id,
                tipo: tipoCoerente,
                colore_ui: UI_CONFIG[tipoCoerente]?.colore || '#9E9E9E',
                classe: item.classe || 'STANDARD',
                marca: marcaVal,
                modello: modelloVal,
                localitaOrigine,
                localitaDestinazione,
                oraPartenza: oraPartenzaEffettiva,
                oraArrivo: determinaArrivoReale(oraPartenzaEffettiva, durataMinutiItem),
                oraRitorno: oraRitornoISO,
                distanza_metri: distMetriItem,
                durata_minuti: Math.round(durataMinutiItem),
                prezzo: prezzoVal,
                prezzo_display: `${prezzoVal}€`,
                postiDisponibili: item.posti_disponibili ?? item.posti_totali ?? 0,
                postiTotali: Number(item.posti_totali || 8),
                is_pool: !!item.is_pool,
                messaggio: item.messaggio || null,
                servizi: parseServizi(item.servizi),
                startOffset: item.startOffset ?? item.calculated_start_offset ?? null,
                endOffset: item.endOffset ?? item.calculated_end_offset ?? null
            }];
        } catch (err) {
            console.error(`💥 [FORMAT] Errore su ID ${item?.id}:`, err);
            return [];
        }
    }));

    return resultsNested.flat().filter(r => r !== null);
}