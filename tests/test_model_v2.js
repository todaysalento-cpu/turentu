import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

// ======================================================
// CARICAMENTO DEL MODELLO REALE
// ======================================================

const modelSource = await readFile(
  new URL('../services/popbus/v2/model.js', import.meta.url),
  'utf8'
);

const model = await import(
  'data:text/javascript;base64,' +
  Buffer.from(modelSource).toString('base64')
);

const {
  generaCandidate,
  valutaRichieste,
  scegliAttivazioni
} = model;

// ======================================================
// CARICAMENTO DEL WORKER REALE CON DIPENDENZE SIMULATE
// ======================================================

const workerSource = await readFile(
  new URL('../services/popbus/v2/worker.js', import.meta.url),
  'utf8'
);

const importPatterns = [
  /import\s*\{\s*verificaPagamento\s*\}\s*from\s*['"]\.\/acceptance\.js['"];?/g,
  /import\s*\{\s*pool\s*\}\s*from\s*['"]\.\.\/\.\.\/\.\.\/db\/db\.js['"];?/g,
  /import\s*\{\s*getIO\s*\}\s*from\s*['"]\.\.\/\.\.\/\.\.\/socket\.js['"];?/g,
  /import\s*\{\s*generaCandidate\s*,\s*valutaRichieste\s*,\s*scegliAttivazioni\s*\}\s*from\s*['"]\.\/model\.js['"];?/g,
  /import\s*\{\s*pianifica\s*,\s*leg\s*\}\s*from\s*['"]\.\/planner\.js['"];?/g
];

let body = workerSource;

for (const pattern of importPatterns) {
  assert.equal(
    (body.match(pattern) ?? []).length,
    1,
    'Import del worker cambiato: aggiornare il test'
  );

  body = body.replace(pattern, '');
}

assert.doesNotMatch(
  body,
  /^\s*import\s/m,
  'Import non simulato: test interrotto'
);

body = body.replace(
  /export\s+async\s+function\s+processaProposteDinamicheV2/,
  'async function processaProposteDinamicheV2'
);

const factorySource = `
export function creaWorker(mocks) {
  const {
    pool,
    getIO,
    verificaPagamento,
    pianifica,
    leg,
    generaCandidate,
    valutaRichieste,
    scegliAttivazioni
  } = mocks;

  ${body}

  return processaProposteDinamicheV2;
}
`;

const { creaWorker } = await import(
  'data:text/javascript;base64,' +
  Buffer.from(factorySource).toString('base64')
);

// ======================================================
// DATI PER I TEST DEL MODELLO
// A=1, B=2, C=3, D=4
// ======================================================

const base = new Date('2026-10-12T09:00:00Z').getTime();

function richiesta(
  id,
  start,
  end,
  minuti,
  prezzo = 10,
  posti = 1
) {
  return {
    id,
    start_node_id: start,
    end_node_id: end,
    start_datetime: new Date(
      base + minuti * 60000
    ).toISOString(),
    prezzo,
    posti_richiesti: posti,
    classe: 'STANDARD'
  };
}

const richiesteModello = [
  richiesta(1, 1, 2, 0),       // AB
  richiesta(2, 2, 3, 10),      // BC
  richiesta(3, 1, 4, 0, 50)   // AD
];

const pianoAD = {
  nodes: [1, 2, 3, 4],
  classe: 'STANDARD',
  legs: [
    { seconds: 600, metres: 10000 },
    { seconds: 600, metres: 10000 },
    { seconds: 600, metres: 10000 }
  ]
};

const pianoAC = {
  nodes: [1, 2, 3],
  classe: 'STANDARD',
  legs: pianoAD.legs.slice(0, 2)
};

// ======================================================
// OTTO TEST DEL MODELLO
// ======================================================

test('MODELLO: AB BC AD generano anche AC, non CD', () => {
  const percorsi = generaCandidate(richiesteModello)
    .map(c => c.nodes.join('-'));

  assert.deepEqual(
    [...new Set(percorsi)].sort(),
    ['1-2', '1-2-3', '1-4', '2-3']
  );

  assert.ok(!percorsi.includes('3-4'));
});

test('MODELLO: AD include AB e BC, ricavo 70 e picco 2', () => {
  const esito = valutaRichieste(
    pianoAD,
    richiesteModello,
    [3]
  );

  assert.ok(esito);
  assert.equal(esito.revenue, 70);
  assert.equal(esito.peak, 2);
  assert.deepEqual(esito.occupancy, [2, 2, 1]);

  assert.deepEqual(
    esito.requests.map(r => r.id).sort(),
    [1, 2, 3]
  );
});

test('MODELLO: AC non usa il prezzo della richiesta AD', () => {
  const esito = valutaRichieste(
    pianoAC,
    richiesteModello,
    [1, 2]
  );

  assert.ok(esito);
  assert.equal(esito.revenue, 20);
  assert.equal(esito.peak, 1);
  assert.deepEqual(
    esito.requests.map(r => r.id),
    [1, 2]
  );
});

test('MODELLO: concatenazione temporalmente incompatibile esclusa', () => {
  const esito = valutaRichieste(
    pianoAC,
    [
      richiesta(1, 1, 2, 0),
      richiesta(2, 2, 3, 90)
    ],
    [1, 2]
  );

  assert.equal(esito, null);
});

test('MODELLO: posti riutilizzati dopo la discesa', () => {
  const esito = valutaRichieste(
    pianoAC,
    [
      richiesta(1, 1, 2, 0, 10, 4),
      richiesta(2, 2, 3, 10, 10, 4)
    ],
    [1, 2]
  );

  assert.ok(esito);
  assert.equal(esito.peak, 4);
  assert.deepEqual(esito.occupancy, [4, 4]);
});

test('MODELLO: una richiesta non finanzia due attivazioni', () => {
  const intera = valutaRichieste(
    pianoAD,
    richiesteModello,
    [3]
  );

  const breve = valutaRichieste(
    {
      nodes: [1, 2],
      legs: pianoAD.legs.slice(0, 1)
    },
    richiesteModello,
    [1]
  );

  const selezionate = scegliAttivazioni([
    {
      plan: pianoAD,
      evaluation: intera,
      cost: 45,
      vehicle: {
        id: 347,
        driver_id: 2,
        posti_totali: 4
      }
    },
    {
      plan: { nodes: [1, 2] },
      evaluation: breve,
      cost: 5,
      vehicle: {
        id: 349,
        driver_id: 286,
        posti_totali: 4
      }
    }
  ]);

  assert.equal(selezionate.length, 1);
  assert.equal(
    selezionate[0].evaluation.revenue,
    70
  );
});

test('MODELLO: costo e capienza impediscono attivazioni non valide', () => {
  const evaluation = valutaRichieste(
    pianoAD,
    richiesteModello,
    [3]
  );

  const costoEccessivo = scegliAttivazioni([{
    plan: pianoAD,
    evaluation,
    cost: 71,
    vehicle: {
      id: 347,
      driver_id: 2,
      posti_totali: 4
    }
  }]);

  const mezzoPiccolo = scegliAttivazioni([{
    plan: pianoAD,
    evaluation,
    cost: 45,
    vehicle: {
      id: 347,
      driver_id: 2,
      posti_totali: 1
    }
  }]);

  assert.equal(costoEccessivo.length, 0);
  assert.equal(mezzoPiccolo.length, 0);
});

test('MODELLO: concatenazioni senza cicli', () => {
  const candidate = generaCandidate([
    richiesta(1, 1, 2, 0),
    richiesta(2, 2, 1, 10)
  ]);

  assert.ok(
    candidate.every(
      c => new Set(c.nodes).size === c.nodes.length
    )
  );
});

// ======================================================
// SIMULAZIONE DELLE DIPENDENZE DEL WORKER
// ======================================================

function scenario({
  richiestePresenti = true,
  pagamentoValido = true,
  veicoliPresenti = true,
  erroreOfferta = false,
  erroreSocket = false,
  offertaScaduta = false
} = {}) {
  const eventi = [];
  const queryEseguite = [];

  const now = Date.now();

  const r = {
    id: 1,
    cliente_id: 101,
    start_node_id: 1,
    end_node_id: 2,
    start_datetime: new Date(now + 2 * 3600000),
    posti_richiesti: 2,
    prezzo: '20.00',
    classe: 'STANDARD',
    stato: 'in_attesa',
    corsa_id: null,
    payment_intent_id: 'pi_simulato'
  };

  const nodi = [
    { id: 1, nome_nodo: 'A', lat: 40, lon: 18 },
    { id: 2, nome_nodo: 'B', lat: 40.01, lon: 18.01 }
  ];

  const veicolo = {
    id: 347,
    driver_id: 2,
    posti_totali: 4,
    euro_km: '0.60',
    lat: 40,
    lon: 18,
    manual: true,
    start: new Date(now - 3600000),
    fine: new Date(now + 24 * 3600000),
    giorni_esclusi: [],
    inattivita: []
  };

  const client = {
    async query(sql, params = []) {
      const q = sql.replace(/\s+/g, ' ').trim();

      queryEseguite.push({ sql: q, params });

      if (
        q === 'BEGIN' ||
        q === 'COMMIT' ||
        q === 'ROLLBACK'
      ) {
        eventi.push(q);
        return { rows: [] };
      }

      if (q.includes('pg_advisory_xact_lock')) {
        return { rows: [] };
      }

      if (q.startsWith('UPDATE popbus_attivazioni')) {
        return {
          rows: offertaScaduta ? [{ id: 99 }] : []
        };
      }

      if (
        q.startsWith('UPDATE popbus_attivazione_richieste')
      ) {
        eventi.push('RILASCIO_RISERVA');
        return { rows: [] };
      }

      if (
        q.startsWith('UPDATE offerte_autisti') ||
        q.startsWith('UPDATE richieste_pop_bus')
      ) {
        return { rows: [] };
      }

      if (
        q.startsWith('SELECT r.* FROM richieste_pop_bus')
      ) {
        return {
          rows: richiestePresenti ? [r] : []
        };
      }

      if (q.includes('FROM nodi_direttrice WHERE')) {
        return { rows: nodi };
      }

      if (q.startsWith('SELECT v.id,v.driver_id')) {
        return {
          rows: veicoliPresenti ? [veicolo] : []
        };
      }

      // Nessun conflitto o riserva preesistente.
      if (q.startsWith('SELECT 1 FROM')) {
        return { rows: [] };
      }

      if (
        q.startsWith('SELECT * FROM richieste_pop_bus')
      ) {
        return { rows: [r] };
      }

      if (q.startsWith('SELECT id FROM utente')) {
        return { rows: [{ id: 2 }] };
      }

      if (q.startsWith('SELECT id FROM veicolo')) {
        return { rows: [{ id: 347 }] };
      }

      if (
        q.startsWith('INSERT INTO direttrici_virtuali')
      ) {
        return { rows: [{ id: 20 }] };
      }

      if (q.startsWith('SELECT * FROM segmenti')) {
        return { rows: [] };
      }

      if (q.startsWith('INSERT INTO segmenti')) {
        return { rows: [{ id: 30 }] };
      }

      if (
        q.startsWith('INSERT INTO popbus_attivazioni')
      ) {
        eventi.push('ATTIVAZIONE');

        return {
          rows: [{
            id: 40,
            expires_at: new Date(now + 10 * 60000)
          }]
        };
      }

      if (
        q.startsWith(
          'INSERT INTO popbus_attivazione_richieste'
        )
      ) {
        eventi.push('RISERVA');
        return { rows: [] };
      }

      if (
        q.startsWith(
          'INSERT INTO popbus_attivazione_segmenti'
        )
      ) {
        return { rows: [] };
      }

      if (q.startsWith('INSERT INTO offerte_autisti')) {
        if (erroreOfferta) {
          throw new Error('Errore SQL offerta simulato');
        }

        eventi.push('OFFERTA');
        return { rows: [{ id: 50 }] };
      }

      throw new Error(`Query non simulata: ${q}`);
    },

    release() {
      eventi.push('RELEASE');
    }
  };

  const worker = creaWorker({
    ...model,

    pool: {
      async connect() {
        return client;
      }
    },

    async verificaPagamento() {
      eventi.push('VERIFICA_PAGAMENTO');

      if (!pagamentoValido) {
        throw new Error(
          'Autorizzazione simulata non valida'
        );
      }

      return 'autorizzazione';
    },

    async pianifica(candidata) {
      eventi.push('ROUTING');

      return {
        nodes: candidata.nodes,
        classe: candidata.classe,
        legs: [{
          metres: 1000,
          seconds: 600,
          polyline: 'simulata'
        }]
      };
    },

    async leg() {
      return {
        metres: 1000,
        seconds: 600,
        polyline: 'simulata'
      };
    },

    getIO() {
      return {
        to() {
          return {
            emit() {
              eventi.push('SOCKET');

              if (erroreSocket) {
                throw new Error(
                  'Socket simulato non disponibile'
                );
              }
            }
          };
        }
      };
    }
  });

  return { worker, eventi, queryEseguite };
}

// ======================================================
// OTTO TEST DEL WORKER REALE
// ======================================================

test('WORKER: crea attivazione, riserva e offerta', async () => {
  const s = scenario();

  await s.worker();

  assert.ok(s.eventi.includes('ATTIVAZIONE'));
  assert.ok(s.eventi.includes('RISERVA'));
  assert.ok(s.eventi.includes('OFFERTA'));

  assert.equal(
    s.eventi.filter(e => e === 'COMMIT').length,
    2
  );

  assert.equal(s.eventi.at(-1), 'RELEASE');

  const insert = s.queryEseguite.find(q =>
    q.sql.startsWith('INSERT INTO popbus_attivazioni')
  );

  assert.ok(insert);
  assert.equal(insert.params[1], 347);
  assert.equal(insert.params[2], 2);
  assert.equal(insert.params[6], 20);
  assert.ok(Number(insert.params[5]) <= 20);
});

test('WORKER: Socket soltanto dopo il commit finale', async () => {
  const s = scenario();

  await s.worker();

  assert.ok(s.eventi.includes('SOCKET'));

  assert.ok(
    s.eventi.indexOf('SOCKET') >
    s.eventi.lastIndexOf('COMMIT')
  );
});

test('WORKER: nessuna richiesta, nessuna attivazione', async () => {
  const s = scenario({
    richiestePresenti: false
  });

  await s.worker();

  assert.ok(!s.eventi.includes('ATTIVAZIONE'));
  assert.ok(!s.eventi.includes('ROUTING'));
  assert.equal(s.eventi.at(-1), 'RELEASE');
});

test('WORKER: pagamento non autorizzato escluso', async () => {
  const s = scenario({
    pagamentoValido: false
  });

  await s.worker();

  assert.ok(
    s.eventi.includes('VERIFICA_PAGAMENTO')
  );
  assert.ok(!s.eventi.includes('ATTIVAZIONE'));
  assert.ok(!s.eventi.includes('SOCKET'));
});

test('WORKER: nessun mezzo, nessuna offerta', async () => {
  const s = scenario({
    veicoliPresenti: false
  });

  await s.worker();

  assert.ok(!s.eventi.includes('ATTIVAZIONE'));
  assert.ok(!s.eventi.includes('OFFERTA'));
});

test('WORKER: errore SQL, rollback senza Socket', async () => {
  const s = scenario({
    erroreOfferta: true
  });

  await assert.rejects(
    s.worker(),
    /Errore SQL offerta simulato/
  );

  assert.ok(s.eventi.includes('ROLLBACK'));
  assert.ok(!s.eventi.includes('SOCKET'));

  assert.deepEqual(
    s.eventi.slice(-2),
    ['ROLLBACK', 'RELEASE']
  );
});

test('WORKER: errore Socket non annulla il commit', async () => {
  const s = scenario({
    erroreSocket: true
  });

  await s.worker();

  assert.ok(s.eventi.includes('SOCKET'));
  assert.ok(!s.eventi.includes('ROLLBACK'));
  assert.equal(s.eventi.at(-1), 'RELEASE');
});

test('WORKER: scadenza libera la riserva', async () => {
  const s = scenario({
    offertaScaduta: true,
    richiestePresenti: false
  });

  await s.worker();

  assert.ok(
    s.eventi.includes('RILASCIO_RISERVA')
  );

  assert.ok(
    s.eventi.indexOf('RILASCIO_RISERVA') <
    s.eventi.indexOf('COMMIT')
  );
});