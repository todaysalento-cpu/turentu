import assert from 'node:assert/strict';
import test from 'node:test';
import { comuniRaccolta, pianificaPuntiRaccolta, scegliRaccoltaPopbus } from '../services/search/popbus-raccolta.service.js';
import { validatePixelStops } from '../services/pixel/pixel.validation.service.js';

const centro = (codice, lat, popolazione = 2000) => ({ codice, lat, lon: 18.35, popolazione });
const brindisi = centro('074001', 40.65);
const diso = centro('075027', 40.01);
const andrano = centro('075005', 39.995);
const cavallino = centro('075020', 40.22);
const soleto = centro('075076', 40.10);
const poggiardo = centro('075061', 40.033, 6000);
const lecce = centro('075035', 40.24, 60000);
const comuni = new Map([brindisi, diso, andrano, cavallino, soleto, poggiardo, lecce]
    .map(p => [p.codice, p]));
const fermata = (p, id, localita) => ({ ...p, fermata_id: id, nodo_id: id + 100, fermata: 'Stazione', localita });
const sud = fermata(poggiardo, 20, 'Poggiardo');
const nord = fermata(lecce, 30, 'Lecce');
const ripetuta = fermata(diso, 15, 'Diso');
const percorso = (distanzaKm, minuti) => ({ distanzaKm, durataMs: minuti * 60000 });
const opzioni = {
    origine: diso, destinazione: brindisi, codiceOrigine: diso.codice, codiceDestinazione: brindisi.codice,
    distanzaKm: 95, caricaTerritorio: async () => comuni,
    pool: { async query(sql, params) {
        assert.match(sql, /n.codice_istat_comune LIKE \$1/);
        assert.deepEqual(params, ['075%', '074001']);
        return { rows: [nord, ripetuta, sud] };
    } },
    async route(da, a) {
        return a === brindisi ? percorso(87, 65) : percorso(6, 10 + 5 / 60);
    }
};

test('il piano limita a due fermate e copre comuni senza nodi PIXEL', () => {
    const result = pianificaPuntiRaccolta({ comuni, fermate: [nord, sud, ripetuta],
        provincia: '075', destinazione: brindisi, classe: 'MEDIA' });
    assert.deepEqual(result.map(p => p.localita), ['Poggiardo', 'Lecce']);
});

test('Diso e Andrano scelgono la stessa fermata da un piano indipendente dalle richieste', async () => {
    const daAndrano = await scegliRaccoltaPopbus({ ...opzioni, origine: andrano, codiceOrigine: andrano.codice });
    const daDiso = await scegliRaccoltaPopbus(opzioni);
    assert.equal(daDiso.fermata_id, sud.fermata_id);
    assert.equal(daAndrano.fermata_id, sud.fermata_id);
    assert.equal(daDiso.accesso_minuti, 11);
});

test('un punto fuori copertura stradale mantiene il nodo originale', async () => {
    assert.equal(await scegliRaccoltaPopbus({ ...opzioni, origine: soleto, codiceOrigine: soleto.codice,
        async route(da, a) { return a === brindisi ? percorso(87, 65) : percorso(7, 14); } }), null);
});

test('la breve percorrenza evita la selezione dei punti di raccolta', async () => {
    assert.equal(await scegliRaccoltaPopbus({ ...opzioni, distanzaKm: 39.9, pool: null }), null);
});

test('la verifica stradale rifiuta un percorso troppo deviato', async () => {
    const route = async (da, a) => a === brindisi ? percorso(120, 90) : percorso(6, 10);
    assert.equal(await scegliRaccoltaPopbus({ ...opzioni, route }), null);
});

test('il dataset riconosce i quattro comuni anche senza fermate registrate', async () => {
    const dati = await comuniRaccolta();
    for (const { codice } of [diso, andrano, cavallino, soleto]) {
        assert.ok(dati.get(codice)?.popolazione > 0);
    }
});

test('la conferma usa il nodo e la fermata della quotazione', async () => {
    const raccolta_popbus = await scegliRaccoltaPopbus(opzioni);
    const quote = { tipo: 'pop-bus', origine_nodo_territoriale_id: sud.nodo_id,
        destinazione_nodo_territoriale_id: 4, raccolta_popbus };
    const slot = { ...quote, origine_nodo_territoriale_id: 9, origine_fermata_id: 90 };
    const stop = { id: String(sud.fermata_id), nome: sud.fermata, lat: sud.lat, lon: sud.lon };
    const client = { async query(sql, params) {
        if (sql.includes('nodi_territoriali')) {
            assert.deepEqual(params, [[String(sud.nodo_id), '4']]);
            return { rows: [{ id: String(sud.nodo_id), attivo: true }, { id: '4', attivo: true }] };
        }
        assert.match(sql, /f.nodo_territoriale_id = \$2 AND f.attiva/);
        assert.deepEqual(params, [stop.id, String(sud.nodo_id)]);
        return { rows: [stop] };
    } };
    const validated = await validatePixelStops(client, slot, quote);
    assert.equal(validated.origine_nodo_territoriale_id, String(sud.nodo_id));
    assert.equal(validated.origine_fermata_id, stop.id);
    stop.lat += 0.01;
    await assert.rejects(validatePixelStops(client, slot, quote), { status: 409 });
});
