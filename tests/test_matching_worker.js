import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const workerPath = new URL(
  '../services/popbus/matching.worker.js',
  import.meta.url
);

const source = await readFile(workerPath, 'utf8');

// Sostituisce esclusivamente gli import.
// Il corpo del worker viene eseguito senza modificarlo.
const dependencies = {
  pool: {
    path: '../../db/db.js',
    declaration: 'const pool = mocks.pool;'
  },
  elaboraClustering: {
    path: './clusterService.js',
    declaration:
      'const elaboraClustering = mocks.elaboraClustering;'
  },
  gestisciMatchingEDirettrici: {
    path: './directiveMatcher.js',
    declaration:
      'const gestisciMatchingEDirettrici = ' +
      'mocks.gestisciMatchingEDirettrici;'
  },
  calcolaAttivazioneEconomica: {
    path: './economicEngine.js',
    declaration:
      'const calcolaAttivazioneEconomica = ' +
      'mocks.calcolaAttivazioneEconomica;'
  },
  assegnaVeicoliEDirettrici: {
    path: './fleetAllocator.js',
    declaration:
      'const assegnaVeicoliEDirettrici = ' +
      'mocks.assegnaVeicoliEDirettrici;'
  },
  dispatchDirettriciAttive: {
    path: './dispatchService.js',
    declaration:
      'const dispatchDirettriciAttive = ' +
      'mocks.dispatchDirettriciAttive;'
  }
};

let transformed = source;

for (const [name, dependency] of Object.entries(dependencies)) {
  const escapedPath = dependency.path.replace(
    /[.*+?^${}()|[\]\\]/g,
    '\\$&'
  );

  const pattern = new RegExp(
    `import\\s*\\{\\s*${name}\\s*\\}\\s*from\\s*` +
    `['"]${escapedPath}['"]\\s*;?`,
    'g'
  );

  const matches = transformed.match(pattern) ?? [];

  assert.equal(
    matches.length,
    1,
    `Import ${name} non riconosciuto: aggiornare il test`
  );

  transformed = transformed.replace(
    pattern,
    dependency.declaration
  );
}

// Non consente di caricare accidentalmente altri moduli reali.
assert.doesNotMatch(
  transformed,
  /^\s*import\s/m,
  'Import aggiuntivi nel worker: aggiornare le simulazioni'
);

// Genera una factory che riceve le dipendenze simulate.
transformed = transformed.replace(
  /export\s+async\s+function\s+processaProposteDinamiche/,
  'async function processaProposteDinamiche'
);

const factorySource = `
  export function creaWorker(mocks) {
    ${transformed}
    return processaProposteDinamiche;
  }
`;

const { creaWorker } = await import(
  'data:text/javascript;base64,' +
  Buffer.from(factorySource).toString('base64')
);

function scenario({
  segmenti = [10, 11],
  attivati = [
    {
      id: 10,
      direttrice_id: 1,
      start_node_id: 1,
      stato: 'attivo'
    }
  ],
  erroreIn = null
} = {}) {
  const eventi = [];
  const errore = new Error(`Errore simulato: ${erroreIn}`);
  const clusters = [{ id: 'cluster-test' }];

  function registra(fase) {
    eventi.push(fase);

    if (erroreIn === fase) {
      throw errore;
    }
  }

  const client = {
    async query(sql) {
      registra(sql);
      return { rows: [] };
    },

    release() {
      eventi.push('RELEASE');
    }
  };

  const mocks = {
    pool: {
      async connect() {
        registra('CONNECT');
        return client;
      }
    },

    async elaboraClustering(connessione) {
      assert.equal(connessione, client);
      registra('CLUSTER');
      return clusters;
    },

    async gestisciMatchingEDirettrici(connessione, ricevuti) {
      assert.equal(connessione, client);
      assert.equal(ricevuti, clusters);
      registra('MATCHING');
      return segmenti;
    },

    async calcolaAttivazioneEconomica(connessione, ricevuti) {
      assert.equal(connessione, client);
      assert.equal(ricevuti, segmenti);
      registra('ECONOMIA');
      return attivati;
    },

    async assegnaVeicoliEDirettrici(connessione, ricevuti) {
      assert.equal(connessione, client);
      assert.equal(ricevuti, attivati);
      registra('ASSEGNAZIONE');
    },

    async dispatchDirettriciAttive(ricevuti, connessione) {
      assert.equal(connessione, client);
      assert.equal(ricevuti, attivati);
      registra('DISPATCH');

      return new Set(
        ricevuti.map(s => s.direttrice_id)
      ).size;
    }
  };

  return {
    worker: creaWorker(mocks),
    eventi,
    errore
  };
}

test('ciclo completo: fasi in ordine, COMMIT e RELEASE', async () => {
  const s = scenario();

  await s.worker();

  assert.deepEqual(s.eventi, [
    'CONNECT',
    'BEGIN',
    'CLUSTER',
    'MATCHING',
    'ECONOMIA',
    'ASSEGNAZIONE',
    'DISPATCH',
    'COMMIT',
    'RELEASE'
  ]);
});

test('nessun segmento: COMMIT senza economia o dispatch', async () => {
  const s = scenario({ segmenti: [] });

  await s.worker();

  assert.deepEqual(s.eventi, [
    'CONNECT',
    'BEGIN',
    'CLUSTER',
    'MATCHING',
    'COMMIT',
    'RELEASE'
  ]);
});

test('nessun segmento attivato: salta assegnazione', async () => {
  const s = scenario({ attivati: [] });

  await s.worker();

  assert.deepEqual(s.eventi, [
    'CONNECT',
    'BEGIN',
    'CLUSTER',
    'MATCHING',
    'ECONOMIA',
    'DISPATCH',
    'COMMIT',
    'RELEASE'
  ]);
});

const fasi = [
  'CLUSTER',
  'MATCHING',
  'ECONOMIA',
  'ASSEGNAZIONE',
  'DISPATCH'
];

for (const fase of fasi) {
  test(`errore in ${fase}: ROLLBACK e RELEASE`, async () => {
    const s = scenario({ erroreIn: fase });

    await assert.rejects(
      s.worker(),
      err => err === s.errore
    );

    const percorso = [
      'CONNECT',
      'BEGIN',
      ...fasi.slice(0, fasi.indexOf(fase) + 1),
      'ROLLBACK',
      'RELEASE'
    ];

    assert.deepEqual(s.eventi, percorso);
    assert.ok(!s.eventi.includes('COMMIT'));
  });
}

test('errore al COMMIT: tenta ROLLBACK e rilascia connessione', async () => {
  const s = scenario({ erroreIn: 'COMMIT' });

  await assert.rejects(
    s.worker(),
    err => err === s.errore
  );

  assert.deepEqual(s.eventi.slice(-3), [
    'COMMIT',
    'ROLLBACK',
    'RELEASE'
  ]);
});