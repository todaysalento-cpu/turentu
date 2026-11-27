
import assert from 'node:assert/strict';

process.env.NCC_TEST_ROLLBACK_ONLY = '1';

const { confermaPuntoGoogleNcc } = await import(
  '../services/ncc-geografia-prenotazioni.service.js'
);

const INDIRIZZO = 'Via San Giovanni Vianney, 8, Lecce';

const ID_AUTOCOMPLETE =
  'EipWaWEgU2FuIEdpb3Zhbm5pIFZpYW5uZXksIDgsIExlY2NlLCBJdGFsaWEiMBIuChQKEgnJfMMS-C5EExHOHaAQdFo4xhAIKhQKEgkJy8QS-C5EExF_ocD3oP3boQ';

const ID_CANONICO =
  'EjFWaWEgUy4gR2lvdmFubmkgVmlhbm5leSwgOCwgNzMxMDAgTGVjY2UgTEUsIEl0YWx5IjASLgoUChIJyXzDEvguRBMRzh2gEHRaOMYQCCoUChIJCcvEEvguRBMRf6HA96D926E';

let superati = 0;

function componente(tipo, valore, breve = valore) {
  return {
    longText: valore,
    shortText: breve,
    types: [tipo],
    languageCode: 'it'
  };
}

function rispostaGoogle() {
  return {
    id: ID_CANONICO,
    types: ['street_address'],
    location: {
      latitude: 40.354673,
      longitude: 18.189759
    },
    displayName: {
      text: 'Via S. Giovanni Vianney, 8'
    },
    addressComponents: [
      componente('street_number', '8'),
      componente('route', 'Via San Giovanni Vianney'),
      componente('locality', 'Lecce'),
      componente('administrative_area_level_3', 'Lecce'),
      componente('country', 'Italia', 'IT'),
      componente('postal_code', '73100')
    ]
  };
}

function ambiente(opzioni = {}) {
  const scritture = [];
  const sql = [];
  const chiamateGoogle = [];
  const verificheComune = [];

  let rilasci = 0;

  const controller = new AbortController();

  const row = {
    id: '702',
    origine: INDIRIZZO,
    destinazione: 'Aeroporto di Brindisi',
    origine_stato_geo: 'DA_ELABORARE',
    destinazione_stato_geo: 'VALIDATO_AUTO',
    revisione_geo: '2026-11-27 09:00:00.123456+01',
    origine_revisione_geo: null,
    destinazione_revisione_geo: null,
    ...opzioni.row
  };

  const luogo = rispostaGoogle();

  if (opzioni.modifica) {
    opzioni.modifica(luogo);
  }

  const pool = {
    async query(query, params) {
      sql.push(query);
      assert.equal(params[0], 999);
      assert.equal(params[1], '702');
      return { rows: [row] };
    },

    async connect() {
      return {
        async query(query, params) {
          sql.push(query);

          if (query.trim().startsWith('UPDATE')) {
            scritture.push({ query, params });
            return { rowCount: 1 };
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

      return {
        consentito: true,
        risultato: await lavoro({
          signal: controller.signal,

          verificaAttiva() {
            controller.signal.throwIfAborted();
          },

          async autorizzaGeografia() {
            return {
              consentito: !opzioni.budgetEsaurito,
              elementiAutorizzati:
                opzioni.budgetEsaurito ? 0 : 1
            };
          }
        })
      };
    }
  };

  return {
    scritture,
    sql,
    chiamateGoogle,
    verificheComune,
    rilasci: () => rilasci,

    esegui() {
      return confermaPuntoGoogleNcc(
        pool,
        999,
        '702',
        {
          ruolo: 'origine',
          placeId: ID_AUTOCOMPLETE,
          indirizzo: INDIRIZZO
        },
        {
          manager,

          async leggiPunto(placeId, guard) {
            if (!(await guard.autorizza('PLACES'))) {
              throw Object.assign(
                new Error('Budget Google Places esaurito.'),
                { status: 429 }
              );
            }

            chiamateGoogle.push(placeId);
            return luogo;
          },

          async verificaComune(db, dati) {
            verificheComune.push(dati);

            return {
              valido:
                !opzioni.fuoriComune &&
                dati.comuneAtteso === 'Lecce'
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

async function verificaRifiuto(opzioni, messaggio, status = 400) {
  const a = ambiente(opzioni);

  await assert.rejects(
    () => a.esegui(),
    error => {
      assert.equal(error.status, status);
      assert.match(error.message, messaggio);
      return true;
    }
  );

  assert.equal(a.scritture.length, 0);
  assert.equal(a.rilasci(), 0);
}

// 1
await test('Place ID identici', async () => {
  const a = ambiente({
    modifica: p => {
      p.id = ID_AUTOCOMPLETE;
    }
  });

  const r = await a.esegui();

  assert.equal(r.stato, 'VALIDATO_MANUALE');
  assert.equal(a.scritture.length, 1);
  assert.equal(a.scritture[0].params[6], ID_AUTOCOMPLETE);
});

// 2
await test('Place ID differenti - indirizzo reale Lecce', async () => {
  assert.notEqual(ID_AUTOCOMPLETE, ID_CANONICO);

  const a = ambiente();
  const r = await a.esegui();

  assert.equal(r.stato, 'VALIDATO_MANUALE');
  assert.equal(a.chiamateGoogle[0], ID_AUTOCOMPLETE);
  assert.equal(a.verificheComune.length, 1);
  assert.equal(a.scritture.length, 1);
});

// 3
await test('Salvataggio SQL Place ID canonico', async () => {
  const a = ambiente();
  await a.esegui();

  const { query, params } = a.scritture[0];

  assert.match(query, /origine_place_id\s*=\s*\$7/);
  assert.equal(params[0], 999);
  assert.equal(params[1], '702');
  assert.equal(params[4], 40.354673);
  assert.equal(params[5], 18.189759);
  assert.equal(params[6], ID_CANONICO);
  assert.equal(params[7], 'VALIDATO_MANUALE');
  assert.equal(params[8], 'GOOGLE_PLACES_CONFERMATO');
  assert.equal(params[12], true);
  assert.ok(a.sql.includes('COMMIT'));
  assert.equal(a.rilasci(), 1);
});

// 4
await test('Place ID canonico non valido', async () => {
  await verificaRifiuto(
    { modifica: p => { p.id = ''; } },
    /non identifica un punto utilizzabile/
  );
});

// 5
await test('Numero civico differente', async () => {
  await verificaRifiuto(
    {
      modifica: p => {
        p.addressComponents.find(
          c => c.types.includes('street_number')
        ).longText = '18';
      }
    },
    /non conferma/
  );
});

// 6
await test('Via differente', async () => {
  await verificaRifiuto(
    {
      modifica: p => {
        p.addressComponents.find(
          c => c.types.includes('route')
        ).longText = 'Via Roma';
      }
    },
    /non conferma/
  );
});

// 7
await test('Punto fuori dal comune richiesto', async () => {
  await verificaRifiuto(
    { fuoriComune: true },
    /fuori dal comune/
  );
});

// 8
await test('Coordinate non valide', async () => {
  await verificaRifiuto(
    {
      modifica: p => {
        p.location.latitude = 999;
      }
    },
    /non identifica un punto utilizzabile/
  );
});

// 9
await test('Paese diverso da Italia', async () => {
  await verificaRifiuto(
    {
      modifica: p => {
        p.addressComponents.find(
          c => c.types.includes('country')
        ).shortText = 'FR';
      }
    },
    /non identifica un punto utilizzabile/
  );
});

// 10
await test('Punto aeroportuale non ammesso', async () => {
  await verificaRifiuto(
    {
      modifica: p => {
        p.types = ['airport'];
      }
    },
    /non identifica un punto utilizzabile/
  );
});

// 11
await test('Budget Google Places esaurito', async () => {
  await verificaRifiuto(
    { budgetEsaurito: true },
    /Budget Google Places esaurito/,
    429
  );
});

console.log('\nTEST SUPERATI:', superati, '/ 11');
console.log('CHIAMATE GOOGLE REALI: 0');
console.log('SCRITTURE POSTGRESQL REALI: 0');
console.log('TEST PLACE ID CANONICO COMPLETATI');
