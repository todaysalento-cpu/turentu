
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

await test('Validazione automatica valida', async () => {
  const r = await punto();

  assert.equal(r.utilizzabile, true);
  assert.equal(r.statoEffettivo, 'VALIDO');
});

await test('Validazione automatica scaduta', async () => {
  const r = await punto({
    origine_geo_scade_il: passato
  });

  assert.equal(r.utilizzabile, false);
  assert.equal(r.statoEffettivo, 'SCADUTO');
});

await test('Coordinate non valide', async () => {
  const r = await punto({
    origine_lat: 95
  });

  assert.equal(r.utilizzabile, false);
});

await test('Manuale scaduta da riconfermare', async () => {
  const r = await punto({
    origine_stato_geo: 'VALIDATO_MANUALE',
    origine_geo_scade_il: passato
  });

  assert.equal(
    r.statoEffettivo,
    'MANUALE_DA_RICONFERMARE'
  );
});

await test('Manuale valida', async () => {
  const r = await punto({
    origine_stato_geo: 'VALIDATO_MANUALE'
  });

  assert.equal(r.utilizzabile, true);
});

await test('Catalogo valido senza scadenza', async () => {
  const r = await punto(
    riferimentoCatalogo,
    catalogo()
  );

  assert.equal(r.utilizzabile, true);
});

await test('Catalogo non disponibile', async () => {
  const r = await punto(
    riferimentoCatalogo,
    async () => ({ valido: false })
  );

  assert.equal(
    r.statoEffettivo,
    'CATALOGO_NON_DISPONIBILE'
  );
});

await test('Catalogo con riferimento differente', async () => {
  const r = await punto(
    riferimentoCatalogo,
    catalogo({ id: '11' })
  );

  assert.equal(r.utilizzabile, false);
});

await test('Catalogo con coordinate modificate', async () => {
  const r = await punto(
    riferimentoCatalogo,
    catalogo({ lat: 40.36 })
  );

  assert.equal(
    r.statoEffettivo,
    'CATALOGO_DA_AGGIORNARE'
  );
});

await test('Catalogo scaduto', async () => {
  const r = await punto(
    riferimentoCatalogo,
    catalogo({ geo_scade_il: passato })
  );

  assert.equal(r.utilizzabile, false);
});

await test('Indirizzo ambiguo', async () => {
  const r = await punto({
    origine_stato_geo: 'AMBIGUO'
  });

  assert.equal(r.statoEffettivo, 'DA_VERIFICARE');
  assert.equal(r.utilizzabile, false);
});

await test('Errore temporaneo', async () => {
  const r = await punto({
    origine_stato_geo: 'ERRORE_API'
  });

  assert.equal(
    r.statoEffettivo,
    'ERRORE_TEMPORANEO'
  );
});

await test('Priorita classificazione prenotazione', async () => {
  const r = statoPrenotazioneGeograficaNcc(
    {
      utilizzabile: false,
      statoEffettivo: 'DA_ELABORARE'
    },
    {
      utilizzabile: false,
      statoEffettivo: 'MANUALE_DA_RICONFERMARE'
    }
  );

  assert.equal(r, 'MANUALE_DA_RICONFERMARE');
});

await test('Riepilogo misto e conteggi coerenti', async () => {
  const rows = [
    prenotazione({ id: '1' }),

    prenotazione({
      id: '2',
      origine_stato_geo: 'DA_ELABORARE',
      destinazione_stato_geo: 'DA_ELABORARE'
    }),

    prenotazione({
      id: '3',
      origine_geo_scade_il: passato
    }),

    prenotazione({
      id: '4',
      gruppo_approvato: true
    }),

    prenotazione({
      id: '5',
      origine_stato_geo: 'AMBIGUO'
    })
  ];

  const db = {
    async query(sql, params) {
      if (sql.includes('catalogo_luoghi_alias')) {
        return { rows: [] };
      }

      assert.match(sql, /operatore_id = \$1/);
      assert.deepEqual(params, [999]);

      return { rows };
    }
  };

  const r = await calcolaRiepilogoGeograficoNcc(
    db,
    999
  );

  assert.equal(r.totale, 5);
  assert.equal(r.pronte, 1);
  assert.equal(r.giaApprovate, 1);

  assert.equal(r.puntiTotali, 10);
  assert.equal(r.puntiApprovati, 2);
  assert.equal(r.puntiDaValutare, 8);
  assert.equal(r.puntiValidi, 4);
  assert.equal(r.puntiNonValidi, 4);

  assert.equal(r.percentualeValidazione, 50);

  assert.equal(r.classificazioni.PRONTA, 1);
  assert.equal(r.classificazioni.DA_ELABORARE, 1);
  assert.equal(r.classificazioni.SCADUTA, 1);
  assert.equal(r.classificazioni.GIA_APPROVATA, 1);
  assert.equal(r.classificazioni.DA_VERIFICARE, 1);

  assert.equal(
    Object.values(r.classificazioni)
      .reduce((a, b) => a + b, 0),
    r.totale
  );

  assert.equal(
    r.stati.reduce(
      (n, x) => n + x.prenotazioni,
      0
    ),
    r.totale
  );
});

await test('Riepilogo senza prenotazioni', async () => {
  const db = {
    async query() {
      return { rows: [] };
    }
  };

  const r = await calcolaRiepilogoGeograficoNcc(
    db,
    999
  );

  assert.equal(r.totale, 0);
  assert.equal(r.puntiTotali, 0);
  assert.equal(r.pronte, 0);
  assert.equal(r.percentualeValidazione, null);
});

await test('Tutte le prenotazioni approvate', async () => {
  const db = {
    async query() {
      return {
        rows: [
          prenotazione({
            gruppo_approvato: true
          })
        ]
      };
    }
  };

  const r = await calcolaRiepilogoGeograficoNcc(
    db,
    999
  );

  assert.equal(r.giaApprovate, 1);
  assert.equal(r.puntiApprovati, 2);
  assert.equal(r.puntiDaValutare, 0);
  assert.equal(r.pronte, 0);
  assert.equal(r.percentualeValidazione, null);
});

console.log(
  '\nTEST RIEPILOGO SUPERATI:',
  superati,
  '/ 16'
);

console.log('V290.2C.3D TEST COMPLETATI');
