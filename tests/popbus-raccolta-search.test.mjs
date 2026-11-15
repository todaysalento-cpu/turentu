import assert from 'node:assert/strict';
import test from 'node:test';
import { comuniRaccolta, scegliRaccoltaPopbus } from '../services/search/popbus-raccolta.service.js';
import { getRouteGeometry } from '../utils/maps.util.js';
import { validatePixelStops } from '../services/pixel/pixel.validation.service.js';
import { censisciFermateCentroPopbus } from '../services/pixel/pixel-stop-acquisition.service.js';
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

test('salva una fermata OSM nel catalogo con provenienza, senza renderla prenotabile', async t => {
    const centro = { codice: '075001', lat: 40.04, lon: 18.23, popolazione: 35000 };
    t.mock.method(globalThis, 'fetch', async (_url, { body }) => {
        assert.match(body.get('data'), /"ref:ISTAT"="075001"/);
        return { ok: true, async json() {
            return { elements: [{ type: 'node', id: 101, ...centro, tags: { highway: 'bus_stop', name: 'Fermata' } }] };
        } };
    });
    const scritture = [];
    const risultato = rows => ({ rows, rowCount: rows.length });
    const database = {
        async query(sql) {
            if (sql.includes('AS residue')) return risultato([{ nodo_id: 9, residue: 1 }]);
            if (sql.includes('jsonb_to_recordset')) return risultato([{ place_id: 'osm:node:101' }]);
            if (sql.includes('FROM public.nodi_territoriali')) {
                return risultato([{ ...centro, id: 9, codice_istat_comune: centro.codice }]);
            }
            return risultato([]);
        },
        async connect() {
            return { release() {}, async query(sql, params) {
                if (sql.includes('INSERT INTO')) scritture.push([sql, params]);
                if (sql.includes('FROM public.nodi_territoriali')) return risultato([{ id: 9, codice_istat_comune: centro.codice }]);
                if (sql.includes('FROM public.pixel_budget_comunali')) return risultato([{ limite: 1 }]);
                if (sql.includes('COUNT(*)')) return risultato([{ censite: 0 }]);
                if (sql.includes('INSERT INTO public.pixel_fermate\n')) return risultato([{ id: 55 }]);
                return risultato([]);
            } };
        }
    };
    await censisciFermateCentroPopbus(centro, { database, polyline: 'rotta-corta', raggioMetri: 3000 });
    assert.equal(scritture.length, 3);
    assert.deepEqual(scritture[0][1], ['075001', 8]);
    assert.match(scritture[0][0], /ON CONFLICT \(codice_istat_comune\) DO NOTHING/);
    assert.match(scritture[1][0], /FALSE, FALSE/);
    assert.match(scritture[2][0], /'da_verificare'/);
    assert.equal(scritture[2][1][1], 'https://www.openstreetmap.org/node/101');
    assert.equal(JSON.parse(scritture[2][1][2]).licenza, 'ODbL-1.0');
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
