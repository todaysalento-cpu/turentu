
import assert from 'node:assert/strict';

import {
  statoPuntoGeograficoNcc,
  statoPrenotazioneGeograficaNcc,
  calcolaRiepilogoGeograficoNcc
} from '../services/ncc-geografia-stato.service.js';

const adesso = Date.now();

const futuro =
  new Date(adesso + 3600000).toISOString();

const passato =
  new Date(adesso - 3600000).toISOString();

let superati = 0;

async function test(nome, fn) {
  await fn();
  superati++;
  console.log('PASS:', nome);
}

function prenotazione(extra = {}) {
  return {
    id: '1',

    origine: 'Via Roma 10, Lecce',
    destinazione: 'Via Roma 20, Brindisi',

    origine_stato_geo: 'VALIDATO_AUTO',
    destinazione_stato_geo: 'VALIDATO_AUTO',

    origine_lat: 40.35,
    origine_lon: 18.17,

    destinazione_lat: 40.63,
    destinazione_lon: 17.94,

    origine_verificata_il: passato,
    destinazione_verificata_il: passato,

    origine_geo_scade_il: futuro,
    destinazione_geo_scade_il: futuro,

    gruppo_approvato: false,

    ...extra
  };
}

// NCC_TEST_CATALOGO_V2902E2D2A
async function punto(
  extra = {},
  catalogo = async () => ({
    stato: 'NON_TROVATO',
    valido: false
  })
) {
  return statoPuntoGeograficoNcc(
    null,
    prenotazione(extra),
    'origine',
    {
      adesso,
      risolviCatalogo: catalogo
    }
  );
}

function catalogo(extra = {}) {
  return async () => ({
    stato: 'VALIDATO_CATALOGO',
    valido: true,
    punto: {
      id: '10',
      lat: 40.35,
      lon: 18.17,
      geo_scade_il: null,
      tipi_veicolo_ammessi: null,
      ...extra
    }
  });
}

const riferimentoCatalogo = {
  origine_stato_geo: 'VALIDATO_CATALOGO',
  origine_punto_operativo_id: '10'
};


const dettaglioStrada = {
  precisione: 'STRADA',
  posizioneIndicativa: true,
  numeroCivicoMancante: true,
  confermatoDaOperatore: true
};

const manuale = {
  origine_stato_geo: 'VALIDATO_MANUALE',
  origine_fonte_geo: 'GOOGLE_PLACES_CONFERMATO',
  origine_dettaglio_geo: dettaglioStrada
};

async function riepilogo(rows) {
  const db = {
    async query(sql, params) {
      if (sql.includes('catalogo_luoghi_alias')) {
        return { rows: [] };
      }

      assert.deepEqual(params, [999]);
      assert.match(sql, /origine_dettaglio_geo/);
      assert.match(sql, /destinazione_dettaglio_geo/);
      assert.match(sql, /origine_fonte_geo/);
      assert.match(sql, /destinazione_fonte_geo/);

      return { rows };
    }
  };

  return calcolaRiepilogoGeograficoNcc(db, 999);
}

await test('Punto indicativo accettato conta come valido', async () => {
  const r = await riepilogo([
    prenotazione(manuale)
  ]);

  assert.equal(r.pronte, 1);
  assert.equal(r.puntiValidi, 2);
  assert.equal(r.puntiIndicativiAccettati, 1);
  assert.equal(r.puntiValidiSenzaAvvisoStradale, 1);
  assert.equal(r.prenotazioniConPuntiIndicativi, 1);
  assert.equal(r.percentualeValidazione, 100);
});

await test('Due punti indicativi una sola prenotazione', async () => {
  const r = await riepilogo([
    prenotazione({
      ...manuale,
      destinazione_stato_geo: 'VALIDATO_MANUALE',
      destinazione_fonte_geo: 'GOOGLE_PLACES_CONFERMATO',
      destinazione_dettaglio_geo: dettaglioStrada
    })
  ]);

  assert.equal(r.puntiIndicativiAccettati, 2);
  assert.equal(r.prenotazioniConPuntiIndicativi, 1);
  assert.equal(r.puntiValidiSenzaAvvisoStradale, 0);
});

await test('Indicativo scaduto non conta come valido', async () => {
  const r = await riepilogo([
    prenotazione({
      ...manuale,
      origine_geo_scade_il: passato
    })
  ]);

  assert.equal(r.pronte, 0);
  assert.equal(r.puntiValidi, 1);
  assert.equal(r.puntiIndicativiAccettati, 0);
  assert.equal(r.prenotazioniConPuntiIndicativi, 0);
  assert.equal(r.percentualeValidazione, 50);
});

await test('Approvate separate dai punti da valutare', async () => {
  const r = await riepilogo([
    prenotazione({
      ...manuale,
      gruppo_approvato: true
    })
  ]);

  assert.equal(r.giaApprovate, 1);
  assert.equal(r.puntiApprovati, 2);
  assert.equal(r.puntiIndicativiAccettati, 0);
  assert.equal(r.puntiDaValutare, 0);
});

await test('Riepilogo vuoto con nuovi contatori', async () => {
  const r = await riepilogo([]);

  assert.equal(r.puntiIndicativiAccettati, 0);
  assert.equal(r.puntiValidiSenzaAvvisoStradale, 0);
  assert.equal(r.prenotazioniConPuntiIndicativi, 0);
});

await test('Terminale OSM automatico non contato valido', async () => {
  const r = await riepilogo([
    prenotazione({
      origine_fonte_geo: 'OPENSTREETMAP_TERMINAL'
    })
  ]);

  assert.equal(r.pronte, 0);
  assert.equal(r.puntiValidi, 1);
});

console.log('TEST V2 SUPERATI:', superati);
