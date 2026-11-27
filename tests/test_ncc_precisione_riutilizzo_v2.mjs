
import assert from 'node:assert/strict';

import {
  creaRiutilizzoGeograficoNcc
} from '../services/ncc-geografia-riutilizzo.service.js';

const futuro =
  new Date(Date.now() + 3600000).toISOString();

const passato =
  new Date(Date.now() - 3600000).toISOString();

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
    origine_lat: 40.35,
    origine_lon: 18.17,
    origine_verificata_il: passato,
    origine_geo_scade_il: futuro,
    origine_fonte_geo: 'GOOGLE_GEOCODING',
    origine_place_id: 'TEST_PLACE',

    ...extra
  };
}

function ambiente(opzioni = {}) {
  const chiamate = [];
  const query = [];

  const controller = new AbortController();

  const guard = {
    verifica() {
      controller.signal.throwIfAborted();
    },

    async attendi(fn) {
      this.verifica();

      const risultato = await fn();

      this.verifica();

      return risultato;
    }
  };

  const db = {
    // NCC_TEST_CATALOGO_V2902E2D2A
    async query(sql, params) {
      query.push({ sql, params });

      if (opzioni.perditaLeaseCatalogo) {
        controller.abort(
          new Error('NCC_LEASE_PERSO')
        );
        guard.verifica();
      }

      if (sql.includes('catalogo_luoghi_alias')) {

        const alias = params[0];

        const riconosciuto =
          opzioni.catalogoRiconosciuto === true ||
          alias === 'luogo operativo test';

        if (!riconosciuto) {
          return { rows: [] };
        }

        if (opzioni.catalogoAmbiguo) {
          return {
            rows: [
              { id: '5', attivo: true },
              { id: '6', attivo: true }
            ]
          };
        }

        return {
          rows: [{
            id: '5',
            codice: 'TEST',
            nome: 'Luogo test',
            attivo: opzioni.luogoAttivo !== false
          }]
        };
      }

      if (sql.includes('catalogo_punti_operativi')) {
        return {
          rows: opzioni.punti ??
            [{
              id: '10',
              lat: 40.35,
              lon: 18.17,
              geo_scade_il: null,
              tipi_veicolo_ammessi: null
            }]
        };
      }

      throw new Error('Query inattesa');
    }
  };

  const geografia = {
    async validaPunto(indirizzo, ruolo) {
      chiamate.push({ indirizzo, ruolo });

      if (opzioni.perditaLease) {
        controller.abort(
          new Error('NCC_LEASE_PERSO')
        );
      }

      return opzioni.esito ?? {
        stato: 'VALIDATO_AUTO',
        valido: true,
        utilizzabileSimulazione: true,
        indicativo: false,
        lat: 40.40,
        lon: 18.20
      };
    }
  };

  const servizio =
    creaRiutilizzoGeograficoNcc(
      db,
      geografia,
      guard
    );

  return {
    servizio,
    chiamate,
    query,
    controller
  };
}


const dettaglioStrada = {
  precisione: 'STRADA',
  posizioneIndicativa: true,
  numeroCivicoMancante: true,
  numeroCivicoNonRiconosciuto: false,
  confermatoDaOperatore: true,
  civicoVerificatoDaGoogle: false
};

const manuale = {
  origine_stato_geo: 'VALIDATO_MANUALE',
  origine_fonte_geo: 'GOOGLE_PLACES_CONFERMATO',
  origine_dettaglio_geo: dettaglioStrada
};

await test('Riutilizzo conserva precisione stradale', async () => {
  const a = ambiente();

  const r = await a.servizio.valida(
    prenotazione(manuale),
    'origine'
  );

  assert.equal(r.valido, true);
  assert.equal(r.riutilizzato, true);
  assert.equal(r.utilizzabileSimulazione, true);
  assert.equal(r.indicativo, false);
  assert.equal(r.posizioneIndicativa, true);
  assert.equal(r.precisione, 'STRADA');
  assert.equal(r.numeroCivicoMancante, true);
  assert.equal(a.chiamate.length, 0);
});

await test('Consenso non propagato ad altra prenotazione', async () => {
  const a = ambiente();

  const r1 = await a.servizio.valida(
    prenotazione(manuale),
    'origine'
  );

  const r2 = await a.servizio.valida(
    prenotazione({
      id: '2',
      origine_stato_geo: 'DA_ELABORARE'
    }),
    'origine'
  );

  assert.equal(r1.posizioneIndicativa, true);
  assert.notEqual(r2.posizioneIndicativa, true);
  assert.equal(a.chiamate.length, 1);
});

await test('Posizione stradale scaduta esclusa', async () => {
  const a = ambiente();

  const r = await a.servizio.valida(
    prenotazione({
      ...manuale,
      origine_geo_scade_il: passato
    }),
    'origine'
  );

  assert.equal(r.stato, 'MANUALE_DA_RICONFERMARE');
  assert.equal(r.utilizzabileSimulazione, false);
  assert.equal(a.chiamate.length, 0);
});

await test('Civico non riconosciuto preservato', async () => {
  const a = ambiente();

  const r = await a.servizio.valida(
    prenotazione({
      ...manuale,
      origine_dettaglio_geo: {
        ...dettaglioStrada,
        numeroCivicoMancante: false,
        numeroCivicoNonRiconosciuto: true
      }
    }),
    'origine'
  );

  assert.equal(r.numeroCivicoMancante, false);
  assert.equal(r.numeroCivicoNonRiconosciuto, true);
  assert.equal(r.posizioneIndicativa, true);
});

console.log('TEST V2 SUPERATI:', superati);
