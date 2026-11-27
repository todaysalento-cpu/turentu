
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

await test('Automatico valido senza resolver', async () => {
  const a = ambiente();

  const r = await a.servizio.valida(
    prenotazione(),
    'origine'
  );

  assert.equal(r.riutilizzato, true);
  assert.equal(r.utilizzabileSimulazione, true);
  assert.equal(r.lat, 40.35);
  assert.equal(a.chiamate.length, 0);

  assert.equal(
    a.servizio.diagnostica().riutilizzatiAuto,
    1
  );
});

await test('Automatico scaduto rivalutato', async () => {
  const a = ambiente();

  const r = await a.servizio.valida(
    prenotazione({
      origine_geo_scade_il: passato
    }),
    'origine'
  );

  assert.equal(a.chiamate.length, 1);
  assert.equal(r.lat, 40.40);

  assert.equal(
    a.servizio.diagnostica().automaticiScaduti,
    1
  );
});

await test('Manuale valida riutilizzata', async () => {
  const a = ambiente();

  const r = await a.servizio.valida(
    prenotazione({
      origine_stato_geo: 'VALIDATO_MANUALE'
    }),
    'origine'
  );

  assert.equal(r.riutilizzato, true);
  assert.equal(a.chiamate.length, 0);

  assert.equal(
    a.servizio.diagnostica().riutilizzatiManuali,
    1
  );
});

await test('Manuale scaduta non sovrascritta', async () => {
  const a = ambiente();

  const r = await a.servizio.valida(
    prenotazione({
      origine_stato_geo: 'VALIDATO_MANUALE',
      origine_geo_scade_il: passato
    }),
    'origine'
  );

  assert.equal(
    r.stato,
    'MANUALE_DA_RICONFERMARE'
  );

  assert.equal(r.utilizzabileSimulazione, false);
  assert.equal(a.chiamate.length, 0);
});

await test('Manuali differenti non condividono cache', async () => {
  const a = ambiente();

  const r1 = await a.servizio.valida(
    prenotazione({
      origine_stato_geo: 'VALIDATO_MANUALE',
      origine_lat: 40.35
    }),
    'origine'
  );

  const r2 = await a.servizio.valida(
    prenotazione({
      id: '2',
      origine_stato_geo: 'VALIDATO_MANUALE',
      origine_lat: 40.36
    }),
    'origine'
  );

  assert.equal(r1.lat, 40.35);
  assert.equal(r2.lat, 40.36);
  assert.notEqual(r1.lat, r2.lat);
  assert.equal(a.chiamate.length, 0);
});

await test('Catalogo valido ricontrollato', async () => {
  const a = ambiente();

  const r = await a.servizio.valida(
    prenotazione({
      origine: 'Luogo operativo test',
      origine_stato_geo: 'VALIDATO_CATALOGO',
      origine_punto_operativo_id: '10',
      origine_geo_scade_il: null
    }),
    'origine'
  );

  assert.equal(r.riutilizzato, true);
  assert.equal(a.chiamate.length, 0);
  assert.equal(a.query.length, 2);

  assert.equal(
    a.servizio.diagnostica().riutilizzatiCatalogo,
    1
  );
});

await test('Catalogo disattivato rivalutato', async () => {
  const a = ambiente({
    luogoAttivo: false,

    esito: {
      stato: 'DA_VERIFICARE',
      valido: false,
      utilizzabileSimulazione: false,
      indicativo: false
    }
  });

  const r = await a.servizio.valida(
    prenotazione({
      origine: 'Luogo operativo test',
      origine_stato_geo: 'VALIDATO_CATALOGO',
      origine_punto_operativo_id: '10'
    }),
    'origine'
  );

  assert.equal(r.utilizzabileSimulazione, false);
  assert.equal(a.chiamate.length, 1);

  assert.equal(
    a.servizio.diagnostica().catalogoDaRivalutare,
    1
  );
});

await test('Catalogo spostato rivalutato', async () => {
  const a = ambiente({
    punti: [{
      id: '10',
      lat: 40.36,
      lon: 18.17,
      geo_scade_il: null
    }]
  });

  const r = await a.servizio.valida(
    prenotazione({
      origine: 'Luogo operativo test',
      origine_stato_geo: 'VALIDATO_CATALOGO',
      origine_punto_operativo_id: '10'
    }),
    'origine'
  );

  assert.equal(a.chiamate.length, 1);
  assert.equal(r.lat, 40.40);
});

await test('Deduplicazione nuove elaborazioni', async () => {
  const a = ambiente();

  for (const id of ['1', '2', '3']) {
    await a.servizio.valida(
      prenotazione({
        id,
        origine_stato_geo: 'DA_ELABORARE'
      }),
      'origine'
    );
  }

  const d = a.servizio.diagnostica();

  assert.equal(a.chiamate.length, 1);
  assert.equal(d.nuoveElaborazioni, 1);
  assert.equal(d.cacheHit, 2);
});

await test('Cache distinta per ruolo', async () => {
  const a = ambiente();

  const row = prenotazione({
    origine_stato_geo: 'DA_ELABORARE',
    destinazione: 'Via Roma 10, Lecce',
    destinazione_stato_geo: 'DA_ELABORARE'
  });

  await a.servizio.valida(row, 'origine');
  await a.servizio.valida(row, 'destinazione');

  assert.equal(a.chiamate.length, 2);
});

await test('Persistito separato da nuova elaborazione', async () => {
  const a = ambiente();

  const r1 = await a.servizio.valida(
    prenotazione(),
    'origine'
  );

  const r2 = await a.servizio.valida(
    prenotazione({
      id: '2',
      origine_stato_geo: 'DA_ELABORARE'
    }),
    'origine'
  );

  assert.equal(r1.lat, 40.35);
  assert.equal(r2.lat, 40.40);
  assert.equal(a.chiamate.length, 1);
});

await test('Aeroporto indicativo preservato', async () => {
  const a = ambiente({
    esito: {
      stato: 'DA_VERIFICARE',
      valido: false,
      utilizzabileSimulazione: true,
      indicativo: true,
      approvabile: false,
      lat: 40.65,
      lon: 17.95
    }
  });

  const r = await a.servizio.valida(
    prenotazione({
      origine: 'Aeroporto di Brindisi',
      origine_stato_geo: 'DA_ELABORARE'
    }),
    'origine'
  );

  assert.equal(r.indicativo, true);
  assert.equal(r.approvabile, false);
  assert.equal(r.valido, false);
  assert.equal(r.utilizzabileSimulazione, true);
});

await test('Perdita lease durante elaborazione', async () => {
  const a = ambiente({
    perditaLease: true
  });

  await assert.rejects(
    () => a.servizio.valida(
      prenotazione({
        origine_stato_geo: 'DA_ELABORARE'
      }),
      'origine'
    ),
    /NCC_LEASE_PERSO/
  );
});

await test('Sessione interrotta prima del riutilizzo', async () => {
  const a = ambiente();

  a.controller.abort(
    new Error('NCC_LEASE_PERSO')
  );

  await assert.rejects(
    () => a.servizio.valida(
      prenotazione(),
      'origine'
    ),
    /NCC_LEASE_PERSO/
  );

  assert.equal(a.chiamate.length, 0);

  assert.equal(
    a.servizio.diagnostica().riutilizzatiTotali,
    0
  );
});

await test('Contatori diagnostici coerenti', async () => {
  const a = ambiente();

  await a.servizio.valida(
    prenotazione(),
    'origine'
  );

  await a.servizio.valida(
    prenotazione({
      id: '2',
      origine_stato_geo: 'VALIDATO_MANUALE'
    }),
    'origine'
  );

  await a.servizio.valida(
    prenotazione({
      id: '3',
      origine_stato_geo: 'DA_ELABORARE'
    }),
    'origine'
  );

  await a.servizio.valida(
    prenotazione({
      id: '4',
      origine_stato_geo: 'DA_ELABORARE'
    }),
    'origine'
  );

  const d = a.servizio.diagnostica();

  assert.equal(d.riutilizzatiTotali, 2);
  assert.equal(d.nuoveElaborazioni, 1);
  assert.equal(d.cacheHit, 1);
  assert.equal(d.indirizziElaborati, 1);

  assert.equal(
    d.riutilizzatiTotali +
    d.nuoveElaborazioni +
    d.cacheHit,
    4
  );
});

console.log(
  '\nTEST RIUTILIZZO SUPERATI:',
  superati,
  '/ 15'
);

console.log('V290.2D.2 TEST COMPLETATI');
