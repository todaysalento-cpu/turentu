
import assert from 'node:assert/strict';

process.env.NCC_TEST_ROLLBACK_ONLY = '1';

const { confermaPuntoManualeNcc } = await import(
  '../services/ncc-geografia-prenotazioni.service.js'
);

const { statoPuntoGeograficoNcc } = await import(
  '../services/ncc-geografia-stato.service.js'
);

const INDIRIZZO = 'Via del Tasso, 6, Lecce';
const LAT = 40.4584897;
const LON = 18.1829938;

let superati = 0;

function ambiente(opzioni = {}) {
  const scritture = [];
  const sql = [];
  const controller = new AbortController();

  let budget = 0;
  let rilasci = 0;

  const row = {
    id: '681',
    origine: INDIRIZZO,
    destinazione: INDIRIZZO,
    origine_stato_geo: 'DA_ELABORARE',
    destinazione_stato_geo: 'DA_ELABORARE',
    revisione_geo: '2026-11-27 09:00:00.123456+01',
    origine_revisione_geo: null,
    destinazione_revisione_geo: null,
    ...opzioni.row
  };

  const pool = {
    async query(query, params) {
      sql.push(query);

      assert.equal(params[0], 999);
      assert.equal(params[1], '681');

      assert.match(query, /p\.operatore_id = \$1/);
      assert.match(query, /annullata_il IS NULL/);
      assert.match(query, /NOT EXISTS/);
      assert.match(query, /ncc_gruppi_approvati/);

      return {
        rows: opzioni.assente ? [] : [row]
      };
    },

    async connect() {
      return {
        async query(query, params) {
          sql.push(query);

          if (query.trim().startsWith('UPDATE')) {
            scritture.push({ query, params });

            return {
              rowCount: opzioni.conflitto ? 0 : 1
            };
          }

          return { rows: [], rowCount: 0 };
        },

        release() {
          rilasci++;
        }
      };
    }
  };

  const manager = {
    async esegui(operatore, lavoro) {
      assert.equal(operatore, 999);

      if (opzioni.occupato) {
        return { consentito: false };
      }

      return {
        consentito: true,
        risultato: await lavoro({
          signal: controller.signal,

          verificaAttiva() {
            controller.signal.throwIfAborted();
          },

          async autorizzaGeografia() {
            budget++;

            return {
              consentito: false,
              elementiAutorizzati: 0
            };
          }
        })
      };
    }
  };

  return {
    scritture,
    sql,
    budget: () => budget,
    rilasci: () => rilasci,

    esegui() {
      return confermaPuntoManualeNcc(
        pool,
        999,
        '681',
        {
          ruolo: 'origine',
          indirizzo: INDIRIZZO,
          lat: LAT,
          lon: LON,
          confermato: true,
          ...opzioni.body
        },
        {
          manager,

          async riconosciLuogo() {
            return {
              stato: opzioni.catalogo ?? 'NON_TROVATO'
            };
          },

          async verificaComune(db, dati) {
            assert.equal(dati.comuneAtteso, 'Lecce');

            return {
              valido: !opzioni.fuoriComune
            };
          }
        }
      );
    }
  };
}

async function test(nome, fn) {
  await fn();
  superati++;
  console.log('PASS:', nome);
}

async function rifiuto(opzioni, status, messaggio) {
  const a = ambiente(opzioni);

  await assert.rejects(
    () => a.esegui(),
    e => {
      assert.equal(e.status, status);
      assert.match(e.message, messaggio);
      return true;
    }
  );

  assert.equal(a.scritture.length, 0);
  assert.equal(a.budget(), 0);
}

await test('Conferma manuale origine', async () => {
  const a = ambiente();
  const r = await a.esegui();

  assert.equal(r.stato, 'VALIDATO_MANUALE');
  assert.equal(r.fonte, 'OPERATORE_MAPPA');
  assert.equal(r.lat, LAT);
  assert.equal(r.lon, LON);
});

await test('Conferma manuale destinazione', async () => {
  const a = ambiente({
    body: { ruolo: 'destinazione' }
  });

  await a.esegui();

  assert.match(
    a.scritture[0].query,
    /destinazione_lat\s*=\s*\$5/
  );
});

await test('Persistenza SQL e metadati', async () => {
  const a = ambiente();
  await a.esegui();

  const { params, query } = a.scritture[0];

  assert.equal(params[0], 999);
  assert.equal(params[1], '681');
  assert.equal(params[4], LAT);
  assert.equal(params[5], LON);
  assert.equal(params[6], null);
  assert.equal(params[7], 'VALIDATO_MANUALE');
  assert.equal(params[8], 'OPERATORE_MAPPA');
  assert.equal(params[11], null);
  assert.equal(params[12], true);

  const dettaglio = JSON.parse(params[9]);

  assert.equal(dettaglio.confermatoDaOperatore, true);
  assert.equal(dettaglio.operatoreId, '999');
  assert.equal(dettaglio.civicoVerificatoDaGoogle, false);

  assert.match(query, /aggiornata_il IS NOT DISTINCT FROM/);
  assert.ok(a.sql.includes('COMMIT'));
  assert.equal(a.rilasci(), 1);
});

await test('Conferma esplicita obbligatoria', () =>
  rifiuto(
    { body: { confermato: false } },
    400,
    /conferma esplicita/
  )
);

await test('Coordinate fuori intervallo', () =>
  rifiuto(
    { body: { lat: 999 } },
    400,
    /coordinate/
  )
);

await test('Coordinate stringa rifiutate', () =>
  rifiuto(
    { body: { lat: String(LAT) } },
    400,
    /coordinate/
  )
);

await test('Coordinate zero rifiutate', () =>
  rifiuto(
    { body: { lat: 0, lon: 0 } },
    400,
    /coordinate/
  )
);

await test('Coordinate fuori comune', () =>
  rifiuto(
    { fuoriComune: true },
    400,
    /fuori dal comune/
  )
);

await test('Indirizzo modificato', () =>
  rifiuto(
    { row: { origine: 'Via Roma, 5, Lecce' } },
    409,
    /indirizzo.*cambiato/
  )
);

await test('Prenotazione non disponibile', () =>
  rifiuto(
    { assente: true },
    404,
    /non trovata/
  )
);

await test('Catalogo gia validato', () =>
  rifiuto(
    { row: { origine_stato_geo: 'VALIDATO_CATALOGO' } },
    400,
    /verifica dedicata/
  )
);

await test('Terminal OSM protetto', () =>
  rifiuto(
    { row: { origine_fonte_geo: 'OPENSTREETMAP_TERMINAL' } },
    400,
    /verifica dedicata/
  )
);

await test('Punto operativo protetto', () =>
  rifiuto(
    { row: { origine_punto_operativo_id: 123 } },
    400,
    /verifica dedicata/
  )
);

await test('Luogo riconosciuto nel catalogo', () =>
  rifiuto(
    { catalogo: 'RICONOSCIUTO' },
    400,
    /catalogo/
  )
);

await test('Catalogo ambiguo', () =>
  rifiuto(
    { catalogo: 'AMBIGUO' },
    400,
    /catalogo/
  )
);

await test('Aeroporto esplicito', () =>
  rifiuto(
    {
      body: {
        indirizzo: 'Aeroporto di Brindisi, Brindisi'
      }
    },
    400,
    /aeroportuali/
  )
);

await test('Alias aeroportuale BDS', () =>
  rifiuto(
    {
      body: { indirizzo: 'BDS' },
      row: { origine: 'BDS' },
      catalogo: 'RICONOSCIUTO'
    },
    400,
    /comune|catalogo|aeroportuali/
  )
);

await test('Conflitto concorrente', async () => {
  const a = ambiente({ conflitto: true });

  await assert.rejects(
    () => a.esegui(),
    e => e.status === 409
  );

  assert.equal(a.rilasci(), 1);
});

await test('Operatore occupato', () =>
  rifiuto(
    { occupato: true },
    429,
    /verifica.*corso/
  )
);

await test('Nessun consumo budget Google', async () => {
  const a = ambiente();

  await a.esegui();

  assert.equal(a.budget(), 0);
});

await test('Riutilizzo senza Place ID', async () => {
  const a = ambiente();
  await a.esegui();

  const p = a.scritture[0].params;

  const r = await statoPuntoGeograficoNcc(
    {},
    {
      origine: INDIRIZZO,
      origine_stato_geo: p[7],
      origine_lat: p[4],
      origine_lon: p[5],
      origine_place_id: p[6],
      origine_fonte_geo: p[8],
      origine_geo_scade_il: p[10],
      origine_verificata_il: new Date().toISOString()
    },
    'origine',
    {
      async risolviCatalogo() {
        return { stato: 'NON_TROVATO' };
      }
    }
  );

  assert.equal(r.utilizzabile, true);
  assert.equal(r.statoEffettivo, 'VALIDO');
});

console.log('\nTEST SUPERATI:', superati, '/ 21');
console.log('CHIAMATE GOOGLE REALI: 0');
console.log('SCRITTURE POSTGRESQL REALI: 0');
