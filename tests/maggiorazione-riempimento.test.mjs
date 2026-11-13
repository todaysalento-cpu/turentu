import assert from 'node:assert/strict';
import test from 'node:test';
import { maggioraTotalePerRiempimento, piccoCondivisa, ricaviPopbusPerRiempimento } from '../utils/maggiorazione-riempimento.js';

process.env.DATABASE_URL = 'postgresql://test:test@localhost/turentu_pricing_test';
process.env.DATABASE_SSL_MODE = 'verify-full';

const { pool } = await import('../db/db.js');
const { calcolaPrezzo, getTariffe, ripartisciCondivisaModelloA } = await import('../utils/pricing.util.js');

test('maggiorazione proporzionale, capienza limitata e zero compatibile', () => {
    assert.equal(maggioraTotalePerRiempimento(100.123, 0, 8, 8), 100.123);
    assert.equal(maggioraTotalePerRiempimento(100, 40, 0, 8), 100);
    assert.equal(maggioraTotalePerRiempimento(100, 40, 2, 8), 110);
    assert.equal(maggioraTotalePerRiempimento(100, 40, 4, 8), 120);
    assert.equal(maggioraTotalePerRiempimento(100, 40, 8, 8), 140);
    assert.equal(maggioraTotalePerRiempimento(100, 40, 12, 8), 140);
    assert.equal(maggioraTotalePerRiempimento(100, 10, 2, 4), 105);
    assert.equal(maggioraTotalePerRiempimento(100, 40, 2, 0), 100);
});

test('Condivisa: il picco usa intervalli simultanei sulla stessa tratta', () => {
    const prenotazioni = [
        { tratta_id: 1, start_offset: 0, end_offset: 1000, posti_richiesti: 2 },
        { tratta_id: 1, start_offset: 1000, end_offset: 2000, posti_richiesti: 2 },
        { tratta_id: 2, start_offset: 0, end_offset: 1000, posti_richiesti: 3 },
    ];
    assert.equal(piccoCondivisa(prenotazioni), 3);
    assert.equal(piccoCondivisa([
        ...prenotazioni,
        { tratta_id: 1, start_offset: 500, end_offset: 1500, posti_richiesti: 2 },
    ]), 4);
});

test('Modello A: a parità di totale restano identici pesi e centesimi residui', () => {
    const prenotazioni = [
        { id: 1, km: 10, posti: 2 },
        { id: 2, km: 7.5, posti: 1 },
        { id: 3, km: 1.25, posti: 1 },
    ];
    const totale = maggioraTotalePerRiempimento(100, 40, 4, 8);
    const ripartisci = costoCommercialeMissione =>
        ripartisciCondivisaModelloA({ costoCommercialeMissione, kmPrimaPrenotazione: 10, prenotazioni });

    assert.deepEqual(ripartisci(totale), ripartisci(120));
    assert.deepEqual(ripartisci(totale).prenotazioni.map(p => p.prezzoTotale), [83.48, 31.3, 5.22]);
    assert.deepEqual(ripartisci(maggioraTotalePerRiempimento(100, 0, 4, 8)), ripartisci(100));
});

test('Lettura tariffa: filtro e priorità usano il tipo di tariffe, non quello del veicolo', async t => {
    const query = t.mock.method(pool, 'query', async () => ({
        rows: [{ euro_km: '1.20', prezzo_passeggero: '0', posti_totali: 8,
            maggiorazione_riempimento_percentuale: '40' }],
    }));

    for (const soloStandard of [false, true]) {
        const tariffa = await getTariffe(391, soloStandard);
        const [sql, params] = query.mock.calls.at(-1).arguments;
        assert.match(sql, /AND \(NOT \$2::boolean OR t\.tipo = 'standard'\)/);
        assert.match(sql, /ORDER BY\s+\(t\.tipo = 'standard'\) DESC/);
        assert.deepEqual(params, [391, soloStandard]);
        assert.equal(tariffa.euro_km, 1.2);
        assert.equal(tariffa.posti_totali, 8);
        assert.equal(tariffa.maggiorazione_riempimento_percentuale, 40);
    }
});

test('Privata: i posti incidono sul nuovo prezzo solo tramite il riempimento', async t => {
    let percentuale = 0;
    t.mock.method(pool, 'query', async () => ({
        rows: [{ euro_km: '4.25', prezzo_passeggero: 1, posti_totali: 8,
            maggiorazione_riempimento_percentuale: percentuale }],
    }));

    const corsa = { veicolo_id: 5 };
    for (const posti of [1, 4, 8]) {
        assert.equal((await calcolaPrezzo(corsa, posti, 'privata', 10, 10)).prezzo, 50);
    }

    percentuale = 40;
    const quotazione = await calcolaPrezzo(corsa, 4, 'privata', 10, 10);
    assert.equal(quotazione.prezzo, 60);
    assert.equal(quotazione.commissioneImporto, 9);
    assert.equal(quotazione.prezzoRiempimentoConcordato, true);
    assert.equal(quotazione.prezzoPrimaCondivisa, 60);
    assert.equal((await calcolaPrezzo(corsa, 8, 'privata', 10, 10)).prezzo, 70);
    assert.equal((await calcolaPrezzo(corsa, 4, 'standard', 10, 10)).prezzo, 200);
    const storico = await calcolaPrezzo(corsa, 2, 'privata', 10, 10, 0, 'STANDARD', 0, 0, false);
    assert.equal(storico.prezzo, 100);
});

test('Condivisa: prenotazione successiva ricalcola il totale e conserva le autorizzazioni precedenti', async () => {
    const { prenotaCorsa } = await import('../services/prenotazione/prenotazione.service.js');
    const prima = { id: 1, tratta_id: 12, start_offset: 0, end_offset: 10000,
        km_utente: '10', posti_richiesti: 2 };
    const seconda = { ...prima, id: 2 };
    const corse = [{ id: 9, tipo_corsa: 'condivisa', stato: 'prenotabile', posti_totali: 8,
        prezzo_fisso: '110', prenotazione_origine_id: 1,
        base_condivisa_riempimento: '100', percentuale_condivisa_riempimento: '40' }];
    const segmenti = { startIdx: 0, endIdx: 1, startOffset: 0, endOffset: 10000, tratta_id: 12 };
    const aggiornamenti = [];
    let importoAutorizzato = '110';
    const client = {
        async query(sql, values) {
            const statement = sql.trim();
            if (statement.startsWith('SELECT * FROM corse')) {
                assert.match(statement, /FOR UPDATE/);
                return { rows: corse };
            }
            if (statement.startsWith('SELECT id, direzione')) {
                return { rows: [{ stato_temporale: 'programmato', partenza_prevista: new Date() }] };
            }
            if (statement.startsWith('SELECT id FROM prenotazioni')) return { rows: [] };
            if (statement.startsWith('SELECT start_offset')) return { rows: [prima] };
            if (statement.startsWith('INSERT INTO prenotazioni')) return { rows: [{ ...seconda }] };
            if (statement.startsWith('SELECT id, km_utente')) return { rows: [prima, seconda] };
            if (statement.startsWith('SELECT prenotazione_id')) {
                return { rows: [{ prenotazione_id: 1, stato: 'autorizzazione', importo: importoAutorizzato }] };
            }
            if (statement.startsWith('UPDATE')) {
                aggiornamenti.push([statement, values]);
                return { rows: corse };
            }
            throw new Error(statement);
        },
    };

    const prenotazione = await prenotaCorsa(corse[0], 42, 2, segmenti, client);
    assert.equal(prenotazione.prezzo_totale, 60);
    assert.deepEqual(aggiornamenti[0][1], [9, 120, 1, 100, 40]);
    assert.deepEqual(aggiornamenti.slice(1, 3).map(([, values]) => values), [[1, 60, 9], [2, 60, 9]]);

    aggiornamenti.length = 0;
    importoAutorizzato = '59';
    await assert.rejects(
        prenotaCorsa(corse[0], 42, 2, segmenti, client),
        { code: 'NCC_MODEL_A_PAYMENT_INVALID' },
    );
    assert.deepEqual(aggiornamenti, []);
});

test('PopBus: prezzo definitivo e soglia usano gli stessi ricavi e rispettano il tetto', async () => {
    const { valutaEconomiaCiclo } = await import('../services/popbus/v2/cycle-pricing.js');
    const richieste = [
        { id: 2, prezzo: 30, prezzo_massimo_autorizzato: 42 },
        { id: 1, prezzo: 70, prezzo_massimo_autorizzato: 98 },
    ];
    const veicolo = { posti_totali: 8, maggiorazione_riempimento_percentuale: 40 };
    const importi = ricaviPopbusPerRiempimento(richieste, veicolo, 4);
    assert.deepEqual(importi, { 1: 84, 2: 36 });

    const economia = ricaviRichiesteEuro => valutaEconomiaCiclo({
        ricaviRichiesteEuro, kmAvvicinamento: 0, kmMissioni: 100,
        kmTrasferimenti: 0, kmRitornoBase: 0, euroKm: 1,
    });
    assert.equal(economia([70, 30]).economicamenteAttivabile, false);
    assert.equal(economia(Object.values(importi)).economicamenteAttivabile, true);
    assert.equal(economia(Object.values(importi)).ricavoLordoEuro, 120);

    assert.deepEqual(ricaviPopbusPerRiempimento(richieste, veicolo, 8), { 1: 98, 2: 42 });
    assert.deepEqual(ricaviPopbusPerRiempimento(
        [richieste[0], { ...richieste[1], prezzo_massimo_autorizzato: null }], veicolo, 8
    ), { 1: 70, 2: 30 });
    assert.throws(() => ricaviPopbusPerRiempimento(
        [{ ...richieste[0], prezzo_massimo_autorizzato: 35 }, richieste[1]], veicolo, 4
    ), /superiore al tetto/);
});
