import assert from 'node:assert/strict';
import test from 'node:test';
import { scegliRaccoltaPopbus } from '../services/search/popbus-raccolta.service.js';
import { validatePixelStops } from '../services/pixel/pixel.validation.service.js';

const origine = { lat: 39.91, lon: 18.36 };
const destinazione = { lat: 40.63, lon: 17.94 };
const tricase = { nodo_id: '2', fermata_id: '20', localita: 'Tricase', fermata: 'Stazione',
    lat: 39.93, lon: 18.35, distanza: 2500, codice: '075088',
    codice_origine: '075086', localita_origine: 'Tiggiano' };
const altro = { nodo_id: '3', fermata_id: '30', localita: 'Altro nodo', fermata: 'Piazza',
    lat: 39.96, lon: 18.33, distanza: 4500, popolazione: 5000 };

const percorso = (distanzaKm, minuti) => ({ distanzaKm, durataMs: minuti * 60000 });
const opzioni = {
    origine, destinazione, origineNodoId: 1, destinazioneNodoId: 4, distanzaKm: 100,
    pool: { async query(sql, params) {
        assert.match(sql, /LEFT JOIN public\.pixel_demografia/);
        assert.deepEqual(params.slice(0, 2), [1, 4]);
        return { rows: [tricase, altro] };
    } },
    async route(da, a) {
        if (da === origine) return a === tricase ? percorso(4, 6) : percorso(6, 9);
        assert.equal(a, destinazione);
        return percorso(96, 75);
    }
};

test('la prima ricerca può proporre Tricase con zero richieste esistenti', async () => {
    const raccolta = await scegliRaccoltaPopbus(opzioni);
    assert.equal(raccolta.nodo_id, 2);
    assert.equal(raccolta.fermata_id, 20);
    assert.equal(raccolta.accesso_minuti, 6);
});

test('una frazione senza popolazione propria può usare un comune vicino', async () => {
    const gagliano = { ...tricase, codice: '075028', localita: 'Gagliano del Capo',
        codice_origine: '075019', localita_origine: 'Leuca' };
    const raccolta = await scegliRaccoltaPopbus({
        ...opzioni,
        pool: { async query() { return { rows: [gagliano] }; } },
        async route(da) { return da === origine ? percorso(6, 8) : percorso(94, 75); }
    });
    assert.equal(raccolta.localita, 'Gagliano del Capo');
});

test('una ricerca breve mantiene il nodo di partenza senza cercare punti di raccolta', async () => {
    assert.equal(await scegliRaccoltaPopbus({ ...opzioni, distanzaKm: 39.9, pool: null }), null);
});

test('scarta un punto di raccolta troppo lontano su strada', async () => {
    const raccolta = await scegliRaccoltaPopbus({ ...opzioni, async route(da, a) {
        if (da === origine && a === tricase) return percorso(5, 11);
        return opzioni.route(da, a);
    } });
    assert.equal(raccolta.nodo_id, 3);
});

test('la deviazione ammessa è più stretta per la lunga percorrenza', async () => {
    const route = async (da, a) => da === origine ? opzioni.route(da, a) : percorso(176, 120);
    assert.equal(await scegliRaccoltaPopbus({ ...opzioni, distanzaKm: 160, route }), null);
    const raccolta = await scegliRaccoltaPopbus({ ...opzioni, distanzaKm: 150, route });
    assert.equal(raccolta.nodo_id, 2);
});

test('la conferma usa solo il nodo e la fermata della nuova quotazione', async () => {
    const raccolta_popbus = await scegliRaccoltaPopbus(opzioni);
    const quote = { tipo: 'pop-bus', origine_nodo_territoriale_id: 2,
        destinazione_nodo_territoriale_id: 4, raccolta_popbus };
    const slot = { ...quote, origine_nodo_territoriale_id: 9, origine_fermata_id: 90 };
    const fermata = { id: '20', nome: tricase.fermata, lat: tricase.lat, lon: tricase.lon };
    const client = { async query(sql, params) {
        if (sql.includes('nodi_territoriali')) {
            assert.deepEqual(params, [['2', '4']]);
            return { rows: [{ id: '2', attivo: true }, { id: '4', attivo: true }] };
        }
        assert.match(sql, /f.nodo_territoriale_id = \$2 AND f.attiva/);
        assert.deepEqual(params, ['20', '2']);
        return { rows: [fermata] };
    } };
    const validated = await validatePixelStops(client, slot, quote);
    assert.equal(validated.origine_nodo_territoriale_id, '2');
    assert.equal(validated.origine_fermata_id, '20');
    assert.deepEqual(validated.raccolta_popbus, fermata);

    fermata.lat += 0.01;
    await assert.rejects(validatePixelStops(client, slot, quote), { status: 409 });
});
