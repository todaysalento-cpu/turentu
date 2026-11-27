
import assert from 'node:assert/strict';

process.env.NCC_TEST_ROLLBACK_ONLY = '1';

const { confermaPuntoGoogleNcc } = await import(
  '../services/ncc-geografia-prenotazioni.service.js'
);

const INDIRIZZO = 'Via Degli Ammirati, Lecce';

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
          indirizzo: row.origine,
          ...opzioni.body
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



function strada(p) {
  p.types = ['route'];

  p.displayName.text = 'Via Degli Ammirati';

  p.addressComponents = p.addressComponents.filter(
    c => !c.types.includes('street_number')
  );

  p.addressComponents.find(
    c => c.types.includes('route')
  ).longText = 'Via Degli Ammirati';
}

const accetta = {
  accettaPosizioneIndicativa: true
};


function impostaVia(p, nome, civico = null) {
  strada(p);

  p.displayName.text = nome;

  p.addressComponents.find(
    c => c.types.includes('route')
  ).longText = nome;

  if (civico !== null) {
    p.types = ['street_address'];

    p.addressComponents.push(
      componente('street_number', civico)
    );
  }
}

await test('Iniziale ambigua senza civico rifiutata', async () => {
  await verificaRifiuto(
    {
      body: accetta,
      row: {
        origine: 'Via G. Garibaldi, Lecce'
      },
      modifica: p => impostaVia(
        p,
        'Via Giuseppe Garibaldi'
      )
    },
    /non conferma/
  );
});

await test('Altra espansione iniziale rifiutata', async () => {
  await verificaRifiuto(
    {
      body: accetta,
      row: {
        origine: 'Via G. Garibaldi, Lecce'
      },
      modifica: p => impostaVia(
        p,
        'Via Giovanni Garibaldi'
      )
    },
    /non conferma/
  );
});

await test('Iniziale con civico corretto resta compatibile', async () => {
  const a = ambiente({
    row: {
      origine: 'Via G. Garibaldi, 8, Lecce'
    },
    modifica: p => impostaVia(
      p,
      'Via Giuseppe Garibaldi',
      '8'
    )
  });

  const r = await a.esegui();

  assert.equal(r.precisione, 'CIVICO');
  assert.equal(r.posizioneIndicativa, false);
});

await test('Struttura non identificata rifiutata', async () => {
  await verificaRifiuto(
    {
      body: accetta,
      row: {
        origine: 'Hotel Aurora Via Roma, Lecce'
      },
      modifica: p => impostaVia(p, 'Via Roma')
    },
    /non conferma/
  );
});

await test('Struttura tra parentesi non ignorata', async () => {
  await verificaRifiuto(
    {
      body: accetta,
      row: {
        origine: 'Via Roma (Hotel Aurora), Lecce'
      },
      modifica: p => impostaVia(p, 'Via Roma')
    },
    /non conferma/
  );
});

await test('Tipo strada differente rifiutato', async () => {
  await verificaRifiuto(
    {
      body: accetta,
      row: {
        origine: 'Via Roma, Lecce'
      },
      modifica: p => impostaVia(p, 'Viale Roma')
    },
    /non conferma/
  );
});

await test('Articoli equivalenti ancora ammessi', async () => {
  const a = ambiente({
    body: accetta,
    modifica: p => impostaVia(p, 'Via Ammirati')
  });

  const r = await a.esegui();

  assert.equal(r.precisione, 'STRADA');
  assert.equal(r.posizioneIndicativa, true);
});

await test('Spazi equivalenti ancora ammessi', async () => {
  const a = ambiente({
    body: accetta,
    row: {
      origine: 'Via De Gasperi, Lecce'
    },
    modifica: p => impostaVia(p, 'Via Degasperi')
  });

  const r = await a.esegui();

  assert.equal(r.precisione, 'STRADA');
  assert.equal(r.posizioneIndicativa, true);
});

console.log('TEST HARDENING V4:', superati, '/ 8');
