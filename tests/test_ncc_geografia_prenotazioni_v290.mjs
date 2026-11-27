
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

function prenotazione(id, extra = {}) {
  return {
    id: String(id),
    origine: 'Via Roma 10, Lecce',
    destinazione: 'Aeroporto di Brindisi',
    origine_stato_geo: 'DA_ELABORARE',
    destinazione_stato_geo: 'DA_ELABORARE',
    revisione_geo: '2026-11-27 09:00:00.123456+01',
    origine_revisione_geo: null,
    destinazione_revisione_geo: null,
    gruppo_approvato: false,
    ...extra
  };
}

function ambiente(rows, opzioni = {}) {
  const chiamate = [];
  const scritture = [];
  const sql = [];

  // NCC_TEST_TRANSAZIONI_V2902E1B

  let rilasci = 0;
  let connessioni = 0;

  const erroriRilascio = [];

  const controller = new AbortController();

  function interrompi(fase) {
    if (opzioni.perditaLease === fase) {
      controller.abort(
        new Error('NCC_LEASE_PERSO')
      );
    }
  }

  const pool = {
    async query(query, params) {
      sql.push(query);
      return { rows };
    },

    async connect() {
      connessioni++;

      interrompi('CONNESSIONE');

      return {
        async query(query, params) {
          sql.push(query);

          const comando = query.trim();

          if (comando === 'BEGIN') {
            interrompi('BEGIN');
          }

          if (
            comando.includes(
              'pg_advisory_xact_lock'
            )
          ) {
            interrompi('LOCK');
          }

          if (comando === 'ROLLBACK') {
            if (opzioni.erroreRollback) {
              throw new Error(
                'ERRORE_ROLLBACK_SIMULATO'
              );
            }
          }

          if (comando.startsWith('UPDATE')) {

            interrompi('UPDATE');
            scritture.push({ query, params });

            if (opzioni.erroreSql) {
              throw new Error('ERRORE_SQL_SIMULATO');
            }

            return {
              rowCount: opzioni.conflitto ? 0 : 1
            };
          }

          return { rows: [], rowCount: 0 };
        },

        release(error) {
          rilasci++;

          erroriRilascio.push(
            error ?? null
          );
        }
      };
    }
  };

  const manager = {
    async esegui(operatore, lavoro) {
      if (opzioni.occupato) {
        return {
          consentito: false,
          motivo: 'OPERATORE_OCCUPATO'
        };
      }

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

    async validaPunto(indirizzo, ruolo, comuneAtteso, riuso) {
      if (riuso) return riuso;
      chiamate.push({ indirizzo, ruolo });

      interrompi('RESOLVER');

      return opzioni.esito ?? {
        stato: 'VALIDATO_AUTO',
        valido: true,
        originale: indirizzo,
        punto: {
          fonte: 'GOOGLE_GEOCODING',
          lat: 40.35,
          lon: 18.17,
          placeId: 'PLACE_TEST',
          indirizzo
        }
      };
    },

    diagnostica() {
      return { chiamate: chiamate.length };
    }
  });

  return {
    chiamate,
    scritture,
    sql,
    rilasci: () => rilasci,
    connessioni: () => connessioni,
    erroriRilascio,

    esegui(ids = rows.map(r => r.id)) {
      return validaGeografiaPrenotazioniNcc(
        pool,
        999,
        { ids },
        { manager, creaValidazione, massiva: opzioni.massiva, avanzamento: opzioni.avanzamento }
      );
    }
  };
}

await test('Validazione automatica', async () => {
  const a = ambiente([prenotazione(1)]);
  const r = await a.esegui();

  assert.equal(a.chiamate.length, 2);
  assert.equal(a.scritture.length, 2);
  assert.equal(r.risultati.length, 2);

  for (const s of a.scritture) {
    assert.equal(s.params[4], 40.35);
    assert.equal(s.params[5], 18.17);
    assert.equal(s.params[7], 'VALIDATO_AUTO');
    assert.equal(s.params[0], 999);
  }
});

await test('Deduplicazione indirizzi', async () => {
  const a = ambiente([
    prenotazione(1),
    prenotazione(2)
  ]);

  await a.esegui();

  assert.equal(a.chiamate.length, 2);
  assert.equal(a.scritture.length, 4);
});

await test('Protezione validazione manuale', async () => {
  const a = ambiente([
    prenotazione(1, {
      origine_stato_geo: 'VALIDATO_MANUALE'
    })
  ]);

  await a.esegui();

  assert.equal(a.chiamate.length, 1);
  assert.equal(a.chiamate[0].ruolo, 'destinazione');
});

await test('Protezione gruppo approvato', async () => {
  const a = ambiente([
    prenotazione(1, {
      gruppo_approvato: true
    })
  ]);

  const r = await a.esegui();

  assert.equal(a.chiamate.length, 0);
  assert.equal(a.scritture.length, 0);
  assert.equal(
    r.risultati[0].motivo,
    'GRUPPO_GIA_APPROVATO'
  );
});

await test('Precisione timestamp', async () => {
  const row = prenotazione(1);
  const a = ambiente([row]);

  await a.esegui();

  assert.equal(
    a.scritture[0].params[13],
    row.revisione_geo
  );
});

await test('Advisory lock e protezione SQL', async () => {
  const a = ambiente([prenotazione(1)]);

  await a.esegui();

  assert.ok(a.sql.some(q =>
    q.includes('pg_advisory_xact_lock(22022')
  ));

  assert.ok(a.scritture.every(s =>
    s.query.includes('NOT EXISTS') &&
    s.query.includes('VALIDATO_MANUALE')
  ));
});

await test('Conflitto modifica concorrente', async () => {
  const a = ambiente(
    [prenotazione(1)],
    { conflitto: true }
  );

  const r = await a.esegui();

  assert.ok(r.risultati.every(x =>
    x.salvato === false &&
    x.motivo === 'PRENOTAZIONE_MODIFICATA'
  ));
});

await test('Budget geografico esaurito', async () => {
  const a = ambiente(
    [prenotazione(1)],
    {
      esito: {
        stato: 'DA_ELABORARE',
        valido: false,
        motivo: 'BUDGET_GEOCODING'
      }
    }
  );

  const r = await a.esegui();

  assert.equal(a.scritture.length, 0);

  assert.ok(r.risultati.every(x =>
    x.salvato === false
  ));
});

await test('Indirizzo ambiguo senza coordinate valide', async () => {
  const a = ambiente(
    [prenotazione(1)],
    {
      esito: {
        stato: 'AMBIGUO',
        valido: false,
        punto: {
          lat: 40.35,
          lon: 18.17
        }
      }
    }
  );

  await a.esegui();

  assert.equal(a.scritture[0].params[4], null);
  assert.equal(a.scritture[0].params[5], null);
  assert.equal(a.scritture[0].params[7], 'AMBIGUO');
});

await test('Operatore occupato', async () => {
  const a = ambiente(
    [prenotazione(1)],
    { occupato: true }
  );

  await assert.rejects(
    () => a.esegui(),
    e => e.status === 429
  );

  assert.equal(a.chiamate.length, 0);
});

await test('Rollback e rilascio connessione', async () => {
  const a = ambiente(
    [prenotazione(1)],
    { erroreSql: true }
  );

  await assert.rejects(
    () => a.esegui(),
    /ERRORE_SQL_SIMULATO/
  );

  assert.ok(a.sql.includes('ROLLBACK'));
  assert.equal(a.rilasci(), 1);
});

await test('Rifiuto lotto superiore a 10', async () => {
  const a = ambiente([]);

  await assert.rejects(
    () => a.esegui(
      Array.from(
        { length: 11 },
        (_, i) => String(i + 1)
      )
    ),
    e => e.status === 400
  );
});

await test('Rifiuto ID duplicati', async () => {
  const a = ambiente([]);

  await assert.rejects(
    () => a.esegui(['1', '1']),
    e => e.status === 400
  );
});

await test('Prenotazione non disponibile', async () => {
  const a = ambiente([]);

  await assert.rejects(
    () => a.esegui(['1']),
    e => e.status === 404
  );
});


// TEST TRANSAZIONALI V290.2E.1B

await test(
  'Lease perso prima della connessione',
  async () => {
    const a = ambiente(
      [prenotazione(1)],
      { perditaLease: 'RESOLVER' }
    );

    await assert.rejects(
      () => a.esegui(),
      /NCC_LEASE_PERSO/
    );

    assert.equal(a.connessioni(), 0);
    assert.equal(a.rilasci(), 0);
    assert.equal(a.scritture.length, 0);
    assert.ok(!a.sql.includes('COMMIT'));
    assert.ok(!a.sql.includes('ROLLBACK'));
  }
);

await test(
  'Lease perso durante connessione',
  async () => {
    const a = ambiente(
      [prenotazione(1)],
      { perditaLease: 'CONNESSIONE' }
    );

    await assert.rejects(
      () => a.esegui(),
      /NCC_LEASE_PERSO/
    );

    assert.equal(a.connessioni(), 1);
    assert.equal(a.rilasci(), 1);
    assert.equal(a.scritture.length, 0);
    assert.ok(!a.sql.includes('BEGIN'));
    assert.ok(!a.sql.includes('COMMIT'));
    assert.ok(!a.sql.includes('ROLLBACK'));
  }
);

await test(
  'Lease perso durante BEGIN',
  async () => {
    const a = ambiente(
      [prenotazione(1)],
      { perditaLease: 'BEGIN' }
    );

    await assert.rejects(
      () => a.esegui(),
      /NCC_LEASE_PERSO/
    );

    assert.equal(a.scritture.length, 0);
    assert.ok(a.sql.includes('BEGIN'));
    assert.ok(a.sql.includes('ROLLBACK'));
    assert.ok(!a.sql.includes('COMMIT'));
    assert.equal(a.rilasci(), 1);
  }
);

await test(
  'Lease perso durante advisory lock',
  async () => {
    const a = ambiente(
      [prenotazione(1)],
      { perditaLease: 'LOCK' }
    );

    await assert.rejects(
      () => a.esegui(),
      /NCC_LEASE_PERSO/
    );

    assert.equal(a.scritture.length, 0);

    assert.ok(a.sql.some(q =>
      q.includes('pg_advisory_xact_lock')
    ));

    assert.ok(a.sql.includes('ROLLBACK'));
    assert.ok(!a.sql.includes('COMMIT'));
    assert.equal(a.rilasci(), 1);
  }
);

await test(
  'Lease perso durante UPDATE',
  async () => {
    const a = ambiente(
      [prenotazione(1)],
      { perditaLease: 'UPDATE' }
    );

    await assert.rejects(
      () => a.esegui(),
      /NCC_LEASE_PERSO/
    );

    assert.equal(a.scritture.length, 1);
    assert.ok(a.sql.includes('ROLLBACK'));
    assert.ok(!a.sql.includes('COMMIT'));
    assert.equal(a.rilasci(), 1);
  }
);

await test(
  'Rollback fallito e connessione scartata',
  async () => {
    const a = ambiente(
      [prenotazione(1)],
      {
        perditaLease: 'UPDATE',
        erroreRollback: true
      }
    );

    await assert.rejects(
      () => a.esegui(),
      /NCC_LEASE_PERSO/
    );

    assert.ok(a.sql.includes('ROLLBACK'));
    assert.ok(!a.sql.includes('COMMIT'));
    assert.equal(a.rilasci(), 1);

    assert.ok(
      a.erroriRilascio[0] instanceof Error
    );
  }
);

await test(
  'Transazione regolare con commit e rilascio',
  async () => {
    const a = ambiente([prenotazione(1)]);

    const r = await a.esegui();

    assert.equal(a.connessioni(), 2);
    assert.equal(a.rilasci(), 2);
    assert.equal(a.scritture.length, 2);

    assert.equal(
      a.sql.filter(q => q === 'COMMIT').length,
      2
    );

    assert.ok(!a.sql.includes('ROLLBACK'));

    assert.ok(
      a.erroriRilascio.every(e => e === null)
    );

    assert.ok(
      r.risultati.every(x => x.salvato === true)
    );
  }
);


await test('Riuso automatico tra lotti conserva la scadenza', async () => {
  const scadenza = new Date(Date.now() + 60000).toISOString();
  const a = ambiente([prenotazione(1, {
    origine_candidati_riuso: [{
      lat: 40.35, lon: 18.17, normalizzata: 'Via Roma 10, Lecce',
      place_id: 'PLACE_TEST', geo_scade_il: scadenza, fonte_geo: 'GOOGLE_GEOCODING'
    }]
  })]);
  const r = await a.esegui();
  assert.deepEqual(a.chiamate.map(call => call.ruolo), ['destinazione']);
  assert.equal(r.risultati.find(point => point.ruolo === 'origine').riutilizzato, true);
  assert.equal(a.scritture[0].params[10], scadenza);
  assert.ok(a.sql[0].includes('q.operatore_id = p.operatore_id'));
  assert.ok(a.sql[0].includes("q.origine_stato_geo = 'VALIDATO_AUTO'"));
});


await test('Validazione di 96 prenotazioni in una sessione con avanzamento', async () => {
  const righe = Array.from({ length: 96 }, (_, index) => prenotazione(index + 1));
  const avanzamenti = [];
  const a = ambiente(righe, { massiva: true, avanzamento: (done, total) => avanzamenti.push([done, total]) });
  const r = await a.esegui();
  assert.equal(r.prenotazioni, 96);
  assert.equal(r.puntiEsaminati, 192);
  assert.equal(a.chiamate.length, 2);
  assert.deepEqual(avanzamenti, [10, 20, 30, 40, 50, 60, 70, 80, 90].map(done => [done, 96]));
});

console.log('\nTEST SUPERATI:', superati, '/ 23');
console.log('V290.2E.1B TEST COMPLETATI');
