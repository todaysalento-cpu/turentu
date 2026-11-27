
import assert from 'node:assert/strict';

process.env.NCC_TEST_ROLLBACK_ONLY = '1';

const {
  validaGeografiaPrenotazioniNcc
} = await import(
  '../services/ncc-geografia-prenotazioni.service.js'
);

let superati = 0;

async function test(nome, fn) {
  await fn();
  superati++;
  console.log('PASS:', nome);
}

function ambiente(opzioni = {}) {
  const chiamate = [];
  const scritture = [];

  const row = {
    id: '1',
    origine: 'Via Roma 10, Lecce',
    destinazione: 'Via Roma 20, Brindisi',
    origine_stato_geo: 'DA_ELABORARE',
    destinazione_stato_geo: 'DA_ELABORARE',
    revisione_geo: '2026-11-27 09:00:00.123456+01',
    origine_revisione_geo: null,
    destinazione_revisione_geo: null,
    gruppo_approvato: false,
    ...opzioni.row
  };

  const controller = new AbortController();

  const pool = {
    async query() {
      return { rows: [row] };
    },

    async connect() {
      return {
        async query(query, params) {
          if (query.trim().startsWith('UPDATE')) {
            scritture.push({ query, params });

            return { rowCount: 1 };
          }

          return { rows: [], rowCount: 0 };
        },

        release() {}
      };
    }
  };

  const manager = {
    async esegui(operatore, lavoro) {
      return {
        consentito: true,

        risultato: await lavoro({
          signal: controller.signal,

          verificaAttiva() {
            controller.signal.throwIfAborted();
          },

          async autorizzaGeografia() {
            return {
              consentito: true,
              elementiAutorizzati: 1
            };
          }
        })
      };
    }
  };

  const creaValidazione = (db, { guard }) => ({
    guard,

    async validaPunto(indirizzo, ruolo) {
      chiamate.push({ indirizzo, ruolo });

      if (
        opzioni.interrompiAl === chiamate.length
      ) {
        if (opzioni.perditaLease) {
          controller.abort(
            new Error('NCC_LEASE_PERSO')
          );
        } else {
          guard.interrompi(
            'NCC_GEOGRAFIA_DEADLINE'
          );
        }

        guard.verifica();
      }

      return opzioni.esito ?? {
        stato: 'VALIDATO_AUTO',
        valido: true,
        originale: indirizzo,

        punto: {
          fonte: 'GOOGLE_GEOCODING',
          lat: 40.35,
          lon: 18.17,
          placeId: 'TEST_PLACE',
          indirizzo
        }
      };
    },

    diagnostica() {
      return guard.diagnostica();
    }
  });

  return {
    row,
    chiamate,
    scritture,

    esegui() {
      return validaGeografiaPrenotazioniNcc(
        pool,
        999,
        { ids: ['1'] },
        { manager, creaValidazione }
      );
    }
  };
}

await test('Elaborazione completa', async () => {
  const a = ambiente();
  const r = await a.esegui();

  assert.equal(r.parziale, false);
  assert.equal(r.puntiTotali, 2);
  assert.equal(r.puntiEsaminati, 2);
  assert.equal(r.puntiSalvati, 2);
  assert.equal(r.nonElaborati.length, 0);
});

await test('Timeout prima del primo punto', async () => {
  const a = ambiente({ interrompiAl: 1 });
  const r = await a.esegui();

  assert.equal(r.parziale, true);
  assert.equal(r.puntiSalvati, 0);
  assert.equal(r.nonElaborati.length, 2);

  assert.equal(
    r.motivoInterruzione,
    'NCC_GEOGRAFIA_DEADLINE'
  );
});

await test('Timeout dopo il primo salvataggio', async () => {
  const a = ambiente({ interrompiAl: 2 });
  const r = await a.esegui();

  assert.equal(r.parziale, true);
  assert.equal(r.puntiSalvati, 1);
  assert.equal(r.puntiEsaminati, 1);
  assert.equal(a.scritture.length, 1);

  assert.deepEqual(
    r.nonElaborati,
    [{ id: '1', ruolo: 'destinazione' }]
  );
});

await test('Ripresa senza ripetere origine valida', async () => {
  const a = ambiente({
    row: {
      origine_stato_geo: 'VALIDATO_AUTO',
      origine_lat: 40.35,
      origine_lon: 18.17,
      origine_verificata_il:
        new Date().toISOString(),

      origine_geo_scade_il:
        new Date(Date.now() + 3600000)
          .toISOString()
    }
  });

  const r = await a.esegui();

  assert.equal(a.chiamate.length, 1);
  assert.equal(
    a.chiamate[0].ruolo,
    'destinazione'
  );

  assert.equal(r.puntiEsaminati, 2);
  assert.equal(r.puntiSalvati, 1);
  assert.equal(r.parziale, false);
});

await test('Perdita lease non recuperabile', async () => {
  const a = ambiente({
    interrompiAl: 2,
    perditaLease: true
  });

  await assert.rejects(
    () => a.esegui(),
    /NCC_LEASE_PERSO/
  );

  assert.equal(a.scritture.length, 1);
});

await test('Manuale scaduta da riconfermare', async () => {
  const a = ambiente({
    row: {
      origine_stato_geo: 'VALIDATO_MANUALE',
      origine_lat: 40.35,
      origine_lon: 18.17,

      origine_verificata_il:
        new Date(Date.now() - 7200000)
          .toISOString(),

      origine_geo_scade_il:
        new Date(Date.now() - 3600000)
          .toISOString()
    }
  });

  const r = await a.esegui();

  const origine = r.risultati.find(
    x => x.ruolo === 'origine'
  );

  assert.equal(origine.riutilizzato, false);
  assert.equal(origine.richiedeRiconferma, true);
  assert.equal(origine.salvato, false);
  assert.equal(a.chiamate.length, 1);
});

await test('Errore API senza sovrascrittura', async () => {
  const a = ambiente({
    esito: {
      stato: 'ERRORE_API',
      valido: false,
      motivo: 'ERRORE_TEMPORANEO'
    }
  });

  const r = await a.esegui();

  assert.equal(a.scritture.length, 0);
  assert.equal(r.parziale, true);
  assert.equal(r.riprovabili.length, 2);
  assert.equal(r.puntiSalvati, 0);
});

await test('Budget esaurito riprovabile', async () => {
  const a = ambiente({
    esito: {
      stato: 'DA_ELABORARE',
      valido: false,
      motivo: 'BUDGET_GEOCODING'
    }
  });

  const r = await a.esegui();

  assert.equal(r.parziale, true);
  assert.equal(r.riprovabili.length, 2);
  assert.equal(r.nonElaborati.length, 0);
  assert.equal(a.scritture.length, 0);
});

console.log('\nTEST RIPRESA SUPERATI:', superati, '/ 8');
console.log('V290.2C.3B TEST COMPLETATI');
