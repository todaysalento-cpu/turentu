
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

await test('Civico mancante - conferma obbligatoria', async () => {
  await verificaRifiuto(
    { modifica: strada },
    /NCC_CIVICO_MANCANTE/
  );
});

await test('Civico mancante - posizione accettata', async () => {
  const a = ambiente({
    modifica: strada,
    body: accetta
  });

  const r = await a.esegui();

  assert.equal(r.stato, 'VALIDATO_MANUALE');
  assert.equal(r.precisione, 'STRADA');
  assert.equal(r.posizioneIndicativa, true);
  assert.equal(r.avviso, 'CIVICO_MANCANTE');
  assert.equal(a.verificheComune.length, 1);
  assert.equal(a.scritture.length, 1);
});

await test('Civico non riconosciuto - conferma obbligatoria', async () => {
  await verificaRifiuto(
    {
      modifica: strada,
      row: {
        origine: 'Via Degli Ammirati, 8, Lecce'
      }
    },
    /NCC_CIVICO_NON_RICONOSCIUTO/
  );
});

await test('Civico non riconosciuto - posizione accettata', async () => {
  const a = ambiente({
    modifica: strada,
    body: accetta,
    row: {
      origine: 'Via Degli Ammirati, 8, Lecce'
    }
  });

  const r = await a.esegui();

  assert.equal(r.precisione, 'STRADA');
  assert.equal(r.avviso, 'CIVICO_NON_RICONOSCIUTO');
  assert.equal(r.dettaglio.numeroCivicoMancante, false);
  assert.equal(r.dettaglio.numeroCivicoNonRiconosciuto, true);
  assert.equal(a.scritture.length, 1);
});

await test('Civico differente - rifiutato anche con consenso', async () => {
  await verificaRifiuto(
    {
      body: accetta,
      row: {
        origine: 'Via Degli Ammirati, 8, Lecce'
      },
      modifica: p => {
        strada(p);
        p.types = ['street_address'];
        p.addressComponents.push(
          componente('street_number', '18')
        );
      }
    },
    /non conferma/
  );
});

await test('Strada differente - rifiutata', async () => {
  await verificaRifiuto(
    {
      body: accetta,
      modifica: p => {
        strada(p);
        p.addressComponents.find(
          c => c.types.includes('route')
        ).longText = 'Via Roma';
      }
    },
    /non conferma/
  );
});

await test('Comune differente - rifiutato', async () => {
  await verificaRifiuto(
    {
      body: accetta,
      modifica: p => {
        strada(p);

        for (const c of p.addressComponents) {
          if (
            c.types.includes('locality') ||
            c.types.includes('administrative_area_level_3')
          ) {
            c.longText = 'Brindisi';
          }
        }
      }
    },
    /non conferma/
  );
});

await test('Coordinate fuori comune - rifiutate', async () => {
  await verificaRifiuto(
    {
      modifica: strada,
      body: accetta,
      fuoriComune: true
    },
    /fuori dal comune/
  );
});

await test('Indirizzo ambiguo - rifiutato', async () => {
  await verificaRifiuto(
    {
      modifica: strada,
      body: accetta,
      row: {
        origine: 'Via Degli Ammirati vicino Hotel, Lecce'
      }
    },
    /non conferma/
  );
});

await test('Consenso stringa true - rifiutato', async () => {
  await verificaRifiuto(
    {
      modifica: strada,
      body: {
        accettaPosizioneIndicativa: 'true'
      }
    },
    /NCC_CIVICO_MANCANTE/
  );
});

await test('Persistenza SQL metadati precisione', async () => {
  const a = ambiente({
    modifica: strada,
    body: accetta
  });

  await a.esegui();

  const { params } = a.scritture[0];

  const dettaglio = typeof params[9] === 'string'
    ? JSON.parse(params[9])
    : params[9];

  assert.equal(params[7], 'VALIDATO_MANUALE');
  assert.equal(params[8], 'GOOGLE_PLACES_CONFERMATO');
  assert.equal(dettaglio.precisione, 'STRADA');
  assert.equal(dettaglio.posizioneIndicativa, true);
  assert.equal(dettaglio.numeroCivicoMancante, true);
  assert.equal(dettaglio.civicoVerificatoDaGoogle, false);
  assert.equal(dettaglio.confermatoDaOperatore, true);
  assert.equal(dettaglio.operatoreId, '999');
  assert.equal(params[12], true);
  assert.ok(a.sql.includes('COMMIT'));
});

await test('Civico corretto - validazione completa', async () => {
  const a = ambiente({
    row: {
      origine: 'Via Degli Ammirati, 8, Lecce'
    },
    modifica: p => {
      strada(p);
      p.types = ['street_address'];
      p.addressComponents.push(
        componente('street_number', '8')
      );
    }
  });

  const r = await a.esegui();

  assert.equal(r.precisione, 'CIVICO');
  assert.equal(r.posizioneIndicativa, false);
  assert.equal(r.avviso, null);
  assert.equal(r.dettaglio.civicoVerificatoDaGoogle, true);
  assert.equal(a.scritture.length, 1);
});

await test('Comune non specificato - rifiutato', async () => {
  await verificaRifiuto(
    {
      modifica: strada,
      body: accetta,
      row: {
        origine: 'Via Degli Ammirati'
      }
    },
    /non conferma/
  );
});

await test('Consenso non autorizza coordinate non valide', async () => {
  await verificaRifiuto(
    {
      body: accetta,
      modifica: p => {
        strada(p);
        p.location.latitude = 999;
      }
    },
    /non identifica un punto utilizzabile/
  );
});

console.log('TEST SUPERATI:', superati, '/ 14');
console.log('CHIAMATE GOOGLE REALI: 0');
console.log('SCRITTURE POSTGRESQL REALI: 0');
console.log('NCC PRECISIONE STRADA TEST COMPLETATI');
