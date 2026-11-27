import 'dotenv/config';
import assert from 'node:assert/strict';
import { pool } from '../db/db.js';

import {
  confermaPuntoManualeNcc
} from '../services/ncc-geografia-prenotazioni.service.js';

const db = await pool.connect();
const risultati = [];

let scritture = 0;
let chiamateEsterne = 0;

const operatore = 2147483000;
const id = 1;

// Sessione isolata: nessuna dipendenza Redis.

const manager = {
  async esegui(op, fn) {
    const risultato = await fn({
      signal: new AbortController().signal,
      verificaAttiva() {},
      async autorizzaGeografia() {
        chiamateEsterne++;
        throw new Error('CHIAMATA ESTERNA NON AMMESSA');
      }
    });

    return {
      consentito: true,
      risultato
    };
  }
};

// Adattatore isolato.
// Le query sulle prenotazioni possono raggiungere
// esclusivamente le tabelle temporanee.

async function query(sql, params) {
  let testo = String(sql);

  testo = testo
    .replaceAll(
      'public.ncc_prenotazioni_esterne',
      'pg_temp.test_ncc_v16'
    )
    .replaceAll(
      'public.ncc_gruppi_approvati',
      'pg_temp.test_ncc_gruppi_v16'
    );

  if (/^\s*UPDATE\b/i.test(testo)) {
    assert.match(
      testo,
      /^\s*UPDATE pg_temp\.test_ncc_v16\b/i
    );

    scritture++;
  } else {
    assert.match(
      testo,
      /^\s*(SELECT|WITH|BEGIN|COMMIT|ROLLBACK|SET LOCAL)\b/i
    );
  }

  return db.query(testo, params);
}

const poolIsolato = {
  query,
  async connect() {
    return {
      query,
      release() {}
    };
  }
};

const dipendenze = {
  manager,

  // Il catalogo viene simulato.
  // La validazione territoriale rimane reale.
  async riconosciLuogo() {
    return { stato: 'NON_TROVATO' };
  }
};

async function prepara(
  indirizzo,
  stato = 'DA_ELABORARE',
  ruolo = 'origine'
) {
  assert.ok(
    ['origine', 'destinazione'].includes(ruolo)
  );

  await db.query(
    'DELETE FROM pg_temp.test_ncc_gruppi_v16'
  );

  await db.query(
    'DELETE FROM pg_temp.test_ncc_v16'
  );

  await db.query(`
    INSERT INTO pg_temp.test_ncc_v16 (
      id,
      operatore_id,
      cliente,
      origine,
      destinazione,
      prelievo_il,
      passeggeri,
      creata_il,
      aggiornata_il,
      origine_stato_geo,
      destinazione_stato_geo
    )
    VALUES (
      $1, $2, 'TEST V16',
      $3, $4, now(), 1, now(), now(),
      $5, $6
    )
  `, [
    id,
    operatore,
    ruolo === 'origine'
      ? indirizzo
      : 'Via Roma, Lecce',
    ruolo === 'destinazione'
      ? indirizzo
      : 'Via Roma, Lecce',
    ruolo === 'origine'
      ? stato
      : 'DA_ELABORARE',
    ruolo === 'destinazione'
      ? stato
      : 'DA_ELABORARE'
  ]);
}

async function leggi() {
  const { rows } = await db.query(
    'SELECT * FROM pg_temp.test_ncc_v16 WHERE id = $1',
    [id]
  );

  return rows[0];
}

async function punto(gid) {
  const { rows } = await db.query(`
    SELECT
      ST_Y(ST_PointOnSurface(geom)) AS lat,
      ST_X(ST_PointOnSurface(geom)) AS lon
    FROM public.localita_istat_2021
    WHERE gid = $1
  `, [gid]);

  assert.equal(rows.length, 1);

  return rows[0];
}

async function comune(codice) {
  const { rows } = await db.query(`
    SELECT
      ST_Y(ST_PointOnSurface(geom)) AS lat,
      ST_X(ST_PointOnSurface(geom)) AS lon
    FROM public.pixel_confini_comunali
    WHERE codice_istat_comune = $1
  `, [codice]);

  assert.equal(rows.length, 1);

  return rows[0];
}

async function conferma(
  indirizzo,
  coordinate,
  extra = {},
  op = operatore,
  deps = dipendenze
) {
  return confermaPuntoManualeNcc(
    poolIsolato,
    op,
    id,
    {
      ruolo: 'origine',
      indirizzo,
      ...coordinate,
      confermato: true,
      ...extra
    },
    deps
  );
}

async function test(nome, fn) {
  try {
    await fn();

    risultati.push({
      nome,
      esito: 'PASS'
    });
  } catch (e) {
    risultati.push({
      nome,
      esito: 'FAIL',
      errore: e.message
    });
  }
}

async function rifiuto(
  indirizzo,
  coordinate,
  status,
  extra = {},
  op = operatore,
  deps = dipendenze
) {
  const prima = await leggi();
  const numeroScritture = scritture;

  await assert.rejects(
    () => conferma(
      indirizzo,
      coordinate,
      extra,
      op,
      deps
    ),
    e => e.status === status
  );

  assert.equal(scritture, numeroScritture);

  assert.deepEqual(
    await leggi(),
    prima
  );
}

try {
  await db.query(`
    CREATE TEMP TABLE test_ncc_v16 (
      LIKE public.ncc_prenotazioni_esterne
      INCLUDING CONSTRAINTS
    ) ON COMMIT PRESERVE ROWS
  `);

  await db.query(`
    CREATE TEMP TABLE test_ncc_gruppi_v16 (
      operatore_id bigint,
      prenotazioni bigint[]
    ) ON COMMIT PRESERVE ROWS
  `);

  const castromediano = await punto(124);
  const depressa = await punto(158);
  const lucugnano = await punto(259);
  const leuca = await punto(429);
  const giuliano = await punto(232);
  const lecce = await comune('075035');

  const { rows } = await db.query(`
    WITH g AS (
      SELECT
        ST_PointOnSurface(
          ST_Difference(c.geom, l.geom)
        ) AS p
      FROM public.localita_istat_2021 l
      JOIN public.pixel_confini_comunali c
        ON c.codice_istat_comune =
           l.codice_istat_comune
      WHERE l.gid = 124
    )
    SELECT ST_Y(p) AS lat, ST_X(p) AS lon
    FROM g
  `);

  const fuoriCastromediano = rows[0];

  const positivi = [
    [
      'Castromediano',
      castromediano,
      '075020',
      'Cavallino',
      124,
      'Castromediano',
      'origine'
    ],
    [
      'Depressa',
      depressa,
      '075088',
      'Tricase',
      158,
      'Depressa',
      'destinazione'
    ],
    [
      'Santa Maria di Leuca',
      leuca,
      '075019',
      'Castrignano del Capo',
      429,
      'Leuca',
      'origine'
    ],
    [
      'Giuliano di Lecce',
      giuliano,
      '075019',
      'Castrignano del Capo',
      232,
      'Giuliano',
      'destinazione'
    ],
    [
      'Lecce',
      lecce,
      '075035',
      'Lecce',
      null,
      null,
      'origine'
    ]
  ];

  for (const [
    nome,
    coordinate,
    codice,
    comuneAtteso,
    gid,
    localita,
    ruolo
  ] of positivi) {
    await test(
      'Persistenza ' + nome + ' / ' + ruolo,
      async () => {
        const indirizzo = 'Via Roma, ' + nome;

        await prepara(
          indirizzo,
          'DA_ELABORARE',
          ruolo
        );

        const r = await conferma(
          indirizzo,
          coordinate,
          { ruolo }
        );

        const salvato = await leggi();
        const d = salvato[ruolo + '_dettaglio_geo'];

        assert.equal(r.stato, 'VALIDATO_MANUALE');

        assert.equal(
          salvato[ruolo + '_stato_geo'],
          'VALIDATO_MANUALE'
        );

        assert.equal(
          salvato[ruolo + '_fonte_geo'],
          'OPERATORE_MAPPA'
        );

        assert.equal(
          salvato[ruolo + '_lat'],
          coordinate.lat
        );

        assert.equal(
          salvato[ruolo + '_lon'],
          coordinate.lon
        );

        assert.equal(
          salvato[ruolo + '_place_id'],
          null
        );

        assert.equal(
          salvato[ruolo + '_punto_operativo_id'],
          null
        );

        assert.equal(
          d.precisioneTerritoriale,
          gid === null ? 'COMUNE' : 'LOCALITA'
        );

        assert.equal(
          d.comuneAmministrativo,
          comuneAtteso
        );

        assert.equal(d.codiceIstatComune, codice);
        assert.equal(d.localita, localita);

        assert.equal(
          d.localitaGid === null
            ? null
            : Number(d.localitaGid),
          gid
        );

        assert.equal(
          d.precisione,
          'POSIZIONE_MANUALE'
        );

        assert.equal(
          d.confermatoDaOperatore,
          true
        );

        assert.equal(
          d.operatoreId,
          String(operatore)
        );

        assert.equal(
          d.civicoVerificatoDaGoogle,
          false
        );

        assert.ok(
          Date.parse(
            salvato[ruolo + '_geo_scade_il']
          ) > Date.now()
        );

        const altro = ruolo === 'origine'
          ? 'destinazione'
          : 'origine';

        assert.equal(
          salvato[altro + '_stato_geo'],
          'DA_ELABORARE'
        );
      }
    );
  }

  const negativi = [
    [
      'Fuori frazione',
      'Via Roma, Castromediano',
      fuoriCastromediano,
      400
    ],
    [
      'Fuori comune',
      'Via Roma, Castromediano',
      lecce,
      400
    ],
    [
      'Altra frazione stesso comune',
      'Via Roma, Depressa',
      lucugnano,
      400
    ],
    [
      'Localita ambigua',
      'Via Roma, Casalabate',
      lecce,
      400
    ],
    [
      'Localita inesistente',
      'Via Roma, ComuneInesistente',
      lecce,
      400
    ],
    [
      'Aeroporto protetto',
      'Aeroporto di Brindisi (BDS), Brindisi',
      lecce,
      400
    ]
  ];

  for (const [
    nome,
    indirizzo,
    coordinate,
    status
  ] of negativi) {
    await test(nome, async () => {
      await prepara(indirizzo);

      await rifiuto(
        indirizzo,
        coordinate,
        status
      );
    });
  }

  const indirizzo = 'Via Roma, Castromediano';

  await test('Indirizzo modificato', async () => {
    await prepara(indirizzo);

    await rifiuto(
      'Via Verdi, Castromediano',
      castromediano,
      409
    );
  });

  await test('Altro operatore', async () => {
    await prepara(indirizzo);

    await rifiuto(
      indirizzo,
      castromediano,
      404,
      {},
      operatore - 1
    );
  });

  await test('Conferma esplicita assente', async () => {
    await prepara(indirizzo);

    await rifiuto(
      indirizzo,
      castromediano,
      400,
      { confermato: false }
    );
  });

  await test('Coordinate non valide', async () => {
    await prepara(indirizzo);

    await rifiuto(
      indirizzo,
      { lat: 999, lon: 18 },
      400
    );
  });

  await test('Gruppo approvato', async () => {
    await prepara(indirizzo);

    await db.query(`
      INSERT INTO pg_temp.test_ncc_gruppi_v16
      VALUES ($1, ARRAY[$2::bigint])
    `, [operatore, id]);

    await rifiuto(
      indirizzo,
      castromediano,
      404
    );
  });

  await test('Prenotazione annullata', async () => {
    await prepara(indirizzo);

    await db.query(`
      UPDATE pg_temp.test_ncc_v16
      SET annullata_il = now()
      WHERE id = $1
    `, [id]);

    await rifiuto(
      indirizzo,
      castromediano,
      404
    );
  });

  await test('Catalogo riconosciuto', async () => {
    await prepara(indirizzo);

    await rifiuto(
      indirizzo,
      castromediano,
      400,
      {},
      operatore,
      {
        ...dipendenze,
        async riconosciLuogo() {
          return { stato: 'RICONOSCIUTO' };
        }
      }
    );
  });

  await test('Catalogo ambiguo', async () => {
    await prepara(indirizzo);

    await rifiuto(
      indirizzo,
      castromediano,
      400,
      {},
      operatore,
      {
        ...dipendenze,
        async riconosciLuogo() {
          return { stato: 'AMBIGUO' };
        }
      }
    );
  });

  await test('Terminale OSM protetto', async () => {
    await prepara(indirizzo);

    await db.query(`
      UPDATE pg_temp.test_ncc_v16
      SET origine_fonte_geo =
        'OPENSTREETMAP_TERMINAL'
      WHERE id = $1
    `, [id]);

    await rifiuto(
      indirizzo,
      castromediano,
      400
    );
  });

  await test('Nessuna autorizzazione API esterna', async () => {
    assert.equal(chiamateEsterne, 0);
  });

  console.table(risultati);

  const pass = risultati.filter(
    r => r.esito === 'PASS'
  ).length;

  console.log(
    'RISULTATO:',
    pass + '/' + risultati.length
  );

  console.log('SCRITTURE TEMPORANEE:', scritture);
  console.log('AUTORIZZAZIONI API:', chiamateEsterne);

  if (pass !== risultati.length) {
    process.exitCode = 1;
  }

} finally {
  try {
    await db.query('ROLLBACK');

    await db.query(`
      DROP TABLE IF EXISTS
        pg_temp.test_ncc_v16,
        pg_temp.test_ncc_gruppi_v16
    `);

    console.log('PULIZIA TABELLE TEMPORANEE OK');

  } finally {
    db.release();
    await pool.end();
  }
}