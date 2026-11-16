import assert from 'node:assert/strict';
import test from 'node:test';
import { cercaSalitaLocalePrimaDellAlternativa, comuniRaccolta, scegliRaccoltaPopbus } from '../services/search/popbus-raccolta.service.js';
import { getRouteGeometry } from '../utils/maps.util.js';
import { validatePixelStops } from '../services/pixel/pixel.validation.service.js';
import { registerPixelStopCandidate } from '../services/pixel/pixel-stop-registration.service.js';
import { preparaFermataGoogleProvvisoria, scadenzaUtileGoogle } from '../services/pixel/pixel-google-provisional.service.js';
import { censisciFermateCentroPopbus, censisciFermateEstremoPopbus } from '../services/pixel/pixel-stop-acquisition.service.js';
import { assegnaFermatePixel, cercaFermateCandidate } from '../services/popbus/v2/popbus-stop-candidates.service.js';

const origine = { lat: 40, lon: 18.2 };
const destinazione = { lat: 40.65, lon: 17.94 };
const a = { codice: '075039', nodo_id: 10, fermata_id: 20, fermata: 'Piazzale', localita: 'Maglie', lat: 40.1, lon: 18.3 };
const b = { codice: '075035', nodo_id: 11, fermata_id: 21, fermata: 'Stazione', localita: 'Lecce', lat: 40.3, lon: 18.1 };
const percorso = (km, minuti) => ({ distanzaKm: km, durataMs: minuti * 60000 });
const comuni = new Map([[a.codice, { popolazione: 14000 }], [b.codice, { popolazione: 90000 }]]);
const opzioni = {
    origine, destinazione, codiceOrigine: '075003', codiceDestinazione: '074001', distanzaKm: 95,
    caricaTerritorio: async () => comuni,
    async geometria(da, a, options) {
        assert.deepEqual([da, a, options], [origine, destinazione, { shortest: true }]);
        return { polyline: 'rotta-corta', distanzaKm: 90 };
    },
    pool: { async query(sql, params) {
        assert.match(sql, /ST_LineFromEncodedPolyline/);
        if (params[4] === 20000) {
            assert.match(sql, /ST_DWithin\(f.posizione::geography, p.partenza, \$5\)/);
            return { rows: [] };
        }
        assert.match(sql, /ST_DWithin\(f.posizione::geography, p.tracciato, \$5\)/);
        assert.deepEqual(params.slice(0, 5), ['rotta-corta', origine.lon, origine.lat, '074001', 3000]);
        return { rows: [a, b] };
    } },
    async route(da, a) {
        if (a === destinazione) return percorso(80, 60);
        return a === b ? percorso(8, 11) : percorso(5, 6);
    }
};

test('sceglie la rotta piu corta fra le alternative del router', async () => {
    const parti = (points, km, seconds) => ({ overview_polyline: { points },
        legs: [{ distance: { value: km * 1000 }, duration: { value: seconds } }] });
    const fetchImpl = async url => {
        assert.match(url, /alternatives=true/);
        return { ok: true, async json() { return { status: 'OK',
            routes: [parti('veloce', 95, 3600), parti('breve', 90, 4200)] }; } };
    };
    assert.equal((await getRouteGeometry(origine, destinazione, { apiKey: 'test', fetchImpl, shortest: true })).polyline, 'breve');
});

test('tra i comuni vicini al tracciato e accessibili sceglie il piu popoloso', async () => {
    const raccolta = await scegliRaccoltaPopbus(opzioni);
    assert.equal(raccolta.fermata_id, b.fermata_id);
    assert.equal(raccolta.fuori_copertura, false);
});

test('le fermate provvisorie partecipano alla scelta del comune, e il capoluogo puo servire una frazione', async () => {
    const vicina = { ...a, localita: 'Frazione', google_place_id: 'google-vicina' };
    const pop = { ...b, localita: 'Comune maggiore', google_place_id: 'google-popoloso' };
    const scadenzaMinima = new Date(Date.now() + 3600000);
    const capoluogo = { ...a, nodo_id: 99, fermata_id: 100, localita: 'Capoluogo', google_place_id: 'google-centro' };
    const base = {
        ...opzioni,
        scadenzaMinima,
        pool: { async query(sql, args) {
            assert.match(sql, /f.google_geo_scade_il > GREATEST/);
            assert.equal(args[6], scadenzaMinima);
            if (args[7]) {
                assert.equal(args[8], 'Capoluogo');
                return { rows: [capoluogo] };
            }
            return { rows: args[4] === 3000 ? [vicina, pop] : [] };
        } }
    };
    const comunePopoloso = await scegliRaccoltaPopbus(base);
    assert.equal(comunePopoloso.fermata_id, pop.fermata_id);
    assert.equal(comunePopoloso.provvisoria, true);
    const frazione = {
        ...base,
        codiceOrigine: a.codice, localitaOrigine: 'Frazione', comuneOrigine: 'Capoluogo',
        async route(da, a) {
            if (a === destinazione) return percorso(80, 60);
            if (a === pop) return percorso(16, 18);
            return a === capoluogo ? percorso(8, 13) : percorso(3, 5);
        }
    };
    const scelta = await scegliRaccoltaPopbus(frazione);
    assert.equal(scelta.fermata_id, capoluogo.fermata_id);
    assert.equal(scelta.fuori_copertura, true);
    assert.equal(scelta.capoluogo_frazione, true);
    const inaccessibile = await scegliRaccoltaPopbus({
        ...frazione,
        route: async (da, a) => a === capoluogo ? percorso(23, 31) : frazione.route(da, a)
    });
    assert.equal(inaccessibile.fermata_id, vicina.fermata_id);
});

test('prima di usare una raccolta alternativa cerca e acquisisce la salita nel nodo di partenza', async () => {
    const origine = { id: 36, codice_istat_comune: '075098' };
    const fermate = { salita: { fermata_id: 100, nodo_territoriale_id: 36 }, discesa: null };
    let creata = false;
    let tentativi = 0;
    const opzioni = {
        raccolta: { nodo_id: 49, fuori_copertura: true },
        destinazioneNodoId: 3,
        async risolviOrigine() { return origine; },
        async assegnaLocale(nodo) {
            assert.equal(nodo, origine);
            return creata ? fermate : { salita: null, discesa: null };
        },
        async acquisisci() {
            tentativi++;
            creata = true;
            return { aggiornata: true };
        }
    };
    assert.deepEqual(await cercaSalitaLocalePrimaDellAlternativa(opzioni), { origine, fermate });
    assert.equal(tentativi, 1);

    creata = false;
    assert.equal(await cercaSalitaLocalePrimaDellAlternativa({
        ...opzioni, acquisisci: async () => ({ aggiornata: false })
    }), null);
    for (const raccolta of [
        { nodo_id: 49, fuori_copertura: false },
        { nodo_id: 38, fuori_copertura: true, capoluogo_frazione: true }
    ]) {
        assert.equal(await cercaSalitaLocalePrimaDellAlternativa({ ...opzioni, raccolta }), null);
    }
    assert.equal(tentativi, 1);
});

test('una fermata ordinaria ha priorita su una raccolta fuori copertura', async () => {
    const raccolta = await scegliRaccoltaPopbus({ ...opzioni, async route(da, a) {
        if (a === b) return percorso(16, 19);
        return opzioni.route(da, a);
    } });
    assert.equal(raccolta.fermata_id, a.fermata_id);
    assert.equal(raccolta.fuori_copertura, false);
});

test('fuori copertura restituisce la fermata sul percorso raggiungibile in meno tempo', async () => {
    const raccolta = await scegliRaccoltaPopbus({ ...opzioni, async route(da, a) {
        if (a === destinazione) return percorso(80, 60);
        return a === b ? percorso(16, 27) : percorso(12, 19);
    } });
    assert.equal(raccolta.fermata_id, a.fermata_id);
    assert.equal(raccolta.accesso_minuti, 19);
    assert.equal(raccolta.fuori_copertura, true);
});

test('fuori copertura considera una fermata fuori dal tracciato e scarta accessi oltre 30 minuti', async () => {
    for (const minuti of [21, 31]) {
        const raccolta = await scegliRaccoltaPopbus({
            ...opzioni,
            pool: { async query(sql, params) {
                await opzioni.pool.query(sql, params);
                return { rows: params[4] === 20000 ? [a, b] : [b] };
            } },
            async route(da, a) {
                if (a === destinazione) return percorso(80, 60);
                return a === b ? percorso(43, 54) : percorso(15, minuti);
            }
        });
        if (minuti === 21) {
            assert.equal(raccolta.fermata_id, a.fermata_id);
            assert.equal(raccolta.accesso_minuti, 21);
            assert.equal(raccolta.fuori_copertura, true);
        } else {
            assert.equal(raccolta, null);
        }
    }
});

test('un comune raggiungibile ma con deviazione alta resta una proposta alternativa', async () => {
    const raccolta = await scegliRaccoltaPopbus({ ...opzioni, async route(da, a) {
        if (a === destinazione) return percorso(115, 85);
        return opzioni.route(da, a);
    } });
    assert.equal(raccolta.fermata_id, a.fermata_id);
    assert.equal(raccolta.fuori_copertura, true);
});

test('breve percorrenza e catalogo vuoto mantengono la partenza originale', async () => {
    assert.equal(await scegliRaccoltaPopbus({ ...opzioni, distanzaKm: 39.9, geometria: null }), null);
    assert.equal(await scegliRaccoltaPopbus({ ...opzioni, pool: { async query() { return { rows: [] }; } } }), null);
});

test('recupera la popolazione dei comuni dal dataset', async () => {
    const dati = await comuniRaccolta();
    assert.ok(dati.get('075003')?.popolazione > 0);
    assert.ok(dati.get('075081')?.popolazione > 0);
});

test('individua e censisce il centro compatibile piu popoloso anche senza fermate in catalogo', async () => {
    const centro = { codice: '075001', lat: 40.04, lon: 18.23, popolazione: 35000, distanza_partenza: 5000 };
    const censimenti = [];
    const raccolta = await scegliRaccoltaPopbus({
        ...opzioni,
        pool: { async query(sql, params) {
            if (sql.includes('centri_istat')) {
                assert.ok(JSON.parse(params[3]).some(c => c.codice === centro.codice));
                return { rows: [{ ...a, distanza_partenza: 10000 }, centro] };
            }
            return { rows: params[4] === 3000 ? [a] : [] };
        } },
        caricaTerritorio: async () => new Map([...comuni, [centro.codice, centro]]),
        censisciCentro: async (c, opzioni) => censimenti.push([c.codice, opzioni.polyline])
    });
    assert.deepEqual(censimenti, [[centro.codice, 'rotta-corta']]);
    assert.equal(raccolta.fermata_id, a.fermata_id);
});

test('un comune con budget esaurito non avvia il censimento Google', async t => {
    const centro = { codice: '075001', lat: 40.04, lon: 18.23, popolazione: 35000 };
    t.mock.method(globalThis, 'fetch', async () => assert.fail('Chiamata esterna inattesa'));
    const database = { async query(sql) {
        assert.match(sql, /AS residue/);
        return { rows: [{ nodo_id: 9, residue: 0 }] };
    } };
    assert.equal(await censisciFermateCentroPopbus(centro, { database, raggioMetri: 3000 }), 0);
});

test('usa solo Google ai punti senza fermata e salva i place ID candidati', async t => {
    const punto = { lat: 39.9021, lon: 18.2649 };
    const nodo = { id: 46, codice_istat_comune: '075003' };
    const risultato = rows => ({ rows, rowCount: rows.length });
    const apiKeyOriginale = process.env.GOOGLE_MAPS_API_KEY;
    process.env.GOOGLE_MAPS_API_KEY = 'chiave-test';
    t.after(() => {
        if (apiKeyOriginale === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
        else process.env.GOOGLE_MAPS_API_KEY = apiKeyOriginale;
    });
    let chiamate = 0;
    t.mock.method(globalThis, 'fetch', async (url, { body }) => {
        chiamate++;
        assert.equal(url, 'https://places.googleapis.com/v1/places:searchNearby');
        assert.deepEqual(JSON.parse(body).locationRestriction.circle.center, { latitude: 39.9, longitude: 18.26 });
        const location = { latitude: punto.lat, longitude: punto.lon };
        return { ok: true, async json() { return { places: [
            { id: 'place-1', location, displayName: { text: 'Nome da non salvare' } },
            { id: 'place-2', location, businessStatus: 'CLOSED_PERMANENTLY' },
            { id: 'place-3', location: { ...location, latitude: 39.93 } }
        ] }; } };
    });
    let segnalati;
    const database = {
        async query(sql, params) {
            if (sql.includes('AS residue')) {
                assert.equal(params[4], nodo.id);
                return risultato([{ nodo_id: nodo.id, residue: 3 }]);
            }
            if (sql.includes('INSERT INTO public.pixel_candidati_google')) {
                segnalati = params;
                return risultato([]);
            }
            assert.fail('Query inattesa durante la ricerca Google');
        },
        async connect() { assert.fail('Un candidato Google non va scritto nel catalogo operativo'); }
    };
    const opzioni = { database, raggioMetri: 1500, popolazione: 5000 };
    assert.equal(await censisciFermateEstremoPopbus(nodo, punto, opzioni), 1);
    assert.equal(await censisciFermateEstremoPopbus(nodo, punto, opzioni), 1);
    assert.equal(chiamate, 1);
    assert.deepEqual(segnalati, [nodo.id, ['place-1'], nodo.codice_istat_comune, 3]);
});

test('la registrazione amministrativa attiva una fermata con evidenza ancora da verificare', async () => {
    const risultato = rows => ({ rows, rowCount: rows.length });
    let dichiarazione;
    const database = {
        async connect() {
            return { release() {}, async query(sql, params) {
                if (['BEGIN', 'COMMIT'].includes(sql)) return risultato([]);
                if (sql.includes('FROM public.nodi_territoriali')) return risultato([{ id: 46, codice_istat_comune: '075003' }]);
                if (sql.includes('FROM public.pixel_budget_comunali')) return risultato([{ limite: 5 }]);
                if (sql.includes('COUNT(*)')) return risultato([{ censite: 0 }]);
                if (sql.includes('ST_DWithin')) return risultato([]);
                if (sql.includes('INSERT INTO public.pixel_fermate\n')) return risultato([{ id: 60 }]);
                if (sql.includes('FOR UPDATE OF f')) return risultato([{
                    id: 60, nome: 'Punto di raccolta', attiva: false, verificata: false,
                    nodo_attivo: true, fermata_test: false, evidenza_negativa: false
                }]);
                if (sql.includes('INSERT INTO public.pixel_fermate_fonti')) {
                    assert.match(sql, /'da_verificare'/);
                    dichiarazione = JSON.parse(params[3]);
                    return risultato([{ id: 70 }]);
                }
                if (sql.includes('SET attiva = TRUE')) return risultato([{ attiva: true }]);
                assert.fail('Query inattesa durante la registrazione della fermata');
            } };
        }
    };
    const fermata = await registerPixelStopCandidate({
        nodo_territoriale_id: 46, nome: 'Punto di raccolta', lat: 39.9, lon: 18.26,
        fonte: 'rilievo_operatore', riferimento_fonte: 'Rilievo di prova', autorizzazione_uso_dati: true
    }, { database });
    assert.equal(fermata.attiva, true);
    assert.equal(fermata.verificata, false);
    assert.equal(fermata.attivazione_provvisoria, true);
    assert.equal(dichiarazione.conferma_punto_salita_dichiarata, false);
});

test('la conferma usa il nodo e la fermata della quotazione', async () => {
    const raccolta_popbus = await scegliRaccoltaPopbus(opzioni);
    const quote = { tipo: 'pop-bus', origine_nodo_territoriale_id: b.nodo_id,
        destinazione_nodo_territoriale_id: 4, raccolta_popbus };
    const slot = { ...quote, origine_nodo_territoriale_id: 9, origine_fermata_id: 90 };
    const stop = { id: String(b.fermata_id), nome: b.fermata, lat: b.lat, lon: b.lon };
    const client = { async query(sql, params) {
        if (sql.includes('nodi_territoriali')) {
            assert.deepEqual(params, [[String(b.nodo_id), '4']]);
            return { rows: [{ id: String(b.nodo_id), attivo: true }, { id: '4', attivo: true }] };
        }
        assert.deepEqual(params, [stop.id, String(b.nodo_id)]);
        return { rows: [stop] };
    } };
    const validated = await validatePixelStops(client, slot, quote);
    assert.equal(validated.origine_nodo_territoriale_id, String(b.nodo_id));
    assert.equal(validated.origine_fermata_id, stop.id);
    stop.lat += 0.01;
    await assert.rejects(validatePixelStops(client, slot, quote), { status: 409 });
});

test('assegna due fermate PIXEL compatibili e le lega alla quotazione di entrambe le estremita', async () => {
    const stop = (tipo, id, nodo, punto) => ({
        tipo, fermata_id: id, nodo_territoriale_id: nodo, nome: 'Fermata ' + id, distanza_metri: 100, ...punto
    });
    const candidataSalita = stop('salita', 21, 11, origine);
    const discesaStessoNodo = stop('discesa', 22, 11, destinazione);
    const candidataDiscesa = stop('discesa', 23, 12, destinazione);
    const righe = [candidataSalita, discesaStessoNodo, candidataDiscesa];
    const fermate = await assegnaFermatePixel({
        origine, destinazione, origineNodoId: 9, destinazioneNodoId: 4,
        client: { async query(sql, params) {
            assert.match(sql, /JOIN public.pixel_fermate f/);
            assert.equal(params[1], 1500);
            return { rows: righe };
        } }
    });
    assert.equal(fermate.salita.fermata_id, 21);
    assert.equal(fermate.discesa.fermata_id, 23);

    const quote = { tipo: 'pop-bus', origine_nodo_territoriale_id: 11,
        destinazione_nodo_territoriale_id: 12, fermate_pixel_popbus: fermate };
    const client = { async query(sql, [id, nodo]) {
        if (sql.includes('FROM public.nodi_territoriali')) {
            return { rows: [{ id: '11', attivo: true }, { id: '12', attivo: true }] };
        }
        const row = righe.find(r => String(r.fermata_id) === id && String(r.nodo_territoriale_id) === nodo);
        return { rows: row ? [{ ...row, id }] : [] };
    } };
    const validata = await validatePixelStops(client, { ...quote, destinazione_fermata_id: 22 }, quote);
    assert.equal(validata.origine_fermata_id, '21');
    assert.equal(validata.destinazione_fermata_id, '23');
    candidataDiscesa.lat += 0.01;
    await assert.rejects(validatePixelStops(client, quote, quote), { status: 409 });

    await cercaFermateCandidate({
        richiestaIds: [10],
        client: { async query(sql) {
            assert.match(sql, /destinazione_fermata_id AS fermata_fissata/);
            assert.match(sql, /p\.fermata_fissata IS NULL OR f\.id = p\.fermata_fissata/);
            return { rows: [] };
        } }
    });
});

test('riusa il place ID più vicino con una geometria a scadenza, senza salvare dati descrittivi di Google', async () => {
    const nodo = { id: 46 };
    const scadenzaMinima = scadenzaUtileGoogle(new Date());
    const scritture = [];
    const database = { async query(sql, params) {
        if (sql.includes('FROM public.pixel_candidati_google')) {
            assert.deepEqual(params, [46]);
            return { rows: [{ place_id: 'fuori' }, { place_id: 'vicina' }] };
        }
        assert.match(sql, /FALSE, TRUE, \$4, NOW\(\) \+ interval '7 days'/);
        assert.match(sql, /ON CONFLICT \(nodo_territoriale_id, google_place_id\)/);
        scritture.push(params);
        return { rowCount: 1 };
    } };
    const fetchImpl = async url => ({
        ok: true, json: async () => ({
            displayName: { text: 'Nome Google da non salvare' },
            location: { latitude: url.endsWith('vicina') ? origine.lat : origine.lat + 1, longitude: origine.lon }
        })
    });
    const opzioni = { database, apiKey: 'test', fetchImpl, raggioMetri: 1500, scadenzaMinima };
    assert.equal(await preparaFermataGoogleProvvisoria(nodo, origine, opzioni), true);
    assert.deepEqual(scritture, [[46, origine.lon, origine.lat, 'vicina', scadenzaMinima]]);
    assert.equal(await preparaFermataGoogleProvvisoria(nodo, origine, {
        ...opzioni, scadenzaMinima: new Date(Date.now() + 8 * 86400000)
    }), false);
    assert.equal(scritture.length, 1);
});

test('la prenotazione rifiuta una fermata Google che scade prima della corsa', async () => {
    const partenza = Date.now() + 86400000;
    const salita = { fermata_id: 20, nodo_territoriale_id: 10, ...origine };
    const quote = { tipo: 'pop-bus', start_datetime: new Date(partenza),
        origine_nodo_territoriale_id: 10, destinazione_nodo_territoriale_id: 11,
        fermate_pixel_popbus: { salita } };
    const client = { async query(sql) {
        if (sql.includes('FROM public.nodi_territoriali')) {
            return { rows: [{ id: 10, attivo: true }, { id: 11, attivo: true }] };
        }
        return { rows: [{ id: 20, ...origine, google_place_id: 'g1', google_geo_scade_il: new Date(partenza) }] };
    } };
    await assert.rejects(validatePixelStops(client, quote, quote), { status: 409 });
});

test('una raccolta Google validata conserva il riferimento al punto assegnato', async () => {
    const partenza = Date.now() + 86400000;
    const raccolta = { fermata_id: 20, nodo_id: 10, ...origine, provvisoria: true };
    const quote = { tipo: 'pop-bus', start_datetime: new Date(partenza),
        origine_nodo_territoriale_id: 10, destinazione_nodo_territoriale_id: 11, raccolta_popbus: raccolta };
    const client = { async query(sql) {
        if (sql.includes('FROM public.nodi_territoriali')) {
            return { rows: [{ id: 10, attivo: true }, { id: 11, attivo: true }] };
        }
        return { rows: [{ id: 20, ...origine, google_place_id: 'g1', google_geo_scade_il: new Date(partenza + 86400000) }] };
    } };
    const validata = await validatePixelStops(client, quote, quote);
    assert.equal(validata.raccolta_google, true);
    assert.equal(validata.origine_fermata_id, 20);
});
