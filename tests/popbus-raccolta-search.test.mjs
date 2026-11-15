import assert from 'node:assert/strict';
import test from 'node:test';
import { comuniRaccolta, scegliRaccoltaPopbus } from '../services/search/popbus-raccolta.service.js';
import { getRouteGeometry } from '../utils/maps.util.js';
import { validatePixelStops } from '../services/pixel/pixel.validation.service.js';

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
