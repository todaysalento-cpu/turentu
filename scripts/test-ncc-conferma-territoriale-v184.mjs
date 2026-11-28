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
      'pg_temp.test_ncc_v184'
    )
    .replaceAll(
      'public.ncc_gruppi_approvati',
      'pg_temp.test_ncc_gruppi_v184'
    );

  if (/^\s*UPDATE\b/i.test(testo)) {
    assert.match(
      testo,
      /^\s*UPDATE pg_temp\.test_ncc_v184\b/i
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
    'DELETE FROM pg_temp.test_ncc_gruppi_v184'
  );

  await db.query(
    'DELETE FROM pg_temp.test_ncc_v184'
  );

  await db.query(`
    INSERT INTO pg_temp.test_ncc_v184 (
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
      $1, $2, 'TEST V173',
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
    'SELECT * FROM pg_temp.test_ncc_v184 WHERE id = $1',
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
      errore: e.stack
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
    CREATE TEMP TABLE test_ncc_v184 (
      LIKE public.ncc_prenotazioni_esterne
      INCLUDING CONSTRAINTS
    ) ON COMMIT PRESERVE ROWS
  `);

  await db.query(`
    CREATE TEMP TABLE test_ncc_gruppi_v184 (
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
      INSERT INTO pg_temp.test_ncc_gruppi_v184
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
      UPDATE pg_temp.test_ncc_v184
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
      UPDATE pg_temp.test_ncc_v184
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


  // NCC V17: persistenza indirizzi senza virgola.


  const tiggiano = await comune('075086');
  const surano = await comune('075082');
  const uggiano = await comune('075091');
  const brindisi = await comune('074001');
  const putignano = await comune('072036');

  // NCC V173: nuovi indirizzi senza virgola.


  const positiviV173 = [
    [
      'Via Boccaccio Lecce',
      'Via Boccaccio, Lecce, Italia',
      lecce, '075035', 'Lecce',
      null, null, 'origine'
    ],
    [
      'Via XXIV Maggio Tiggiano',
      'Via XXIV Maggio, Tiggiano, Italia',
      tiggiano, '075086', 'Tiggiano',
      null, null, 'destinazione'
    ],
    [
      'Via Papa Giovanni XXIII Surano',
      'Via Papa Giovanni XXIII, Surano, Italia',
      surano, '075082', 'Surano',
      null, null, 'origine'
    ],
    [
      'Via Palombaro 13 Uggiano la Chiesa',
      'Via Palombaro 13, Uggiano la Chiesa, Italia',
      uggiano, '075091', 'Uggiano la Chiesa',
      null, null, 'destinazione'
    ],
    [
      'Via della Vite Castromediano',
      'Via della Vite, Castromediano, Italia',
      castromediano, '075020', 'Cavallino',
      124, 'Castromediano', 'origine'
    ],
    [
      'Via Regina Elena Giuliano di Lecce',
      'Via Regina Elena, Giuliano di Lecce, Italia',
      giuliano, '075019', 'Castrignano del Capo',
      232, 'Giuliano', 'destinazione'
    ],
    [
      'Via Gioacchino Toma Santa Maria di Leuca',
      'Via Gioacchino Toma, Santa Maria di Leuca, Italia',
      leuca, '075019', 'Castrignano del Capo',
      429, 'Leuca', 'origine'
    ]
  ];

  const positiviV17 = [
    [
      'Via Boccaccio 61 lecce',
      'Via Boccaccio 61, lecce, Italia',
      lecce, '075035', 'Lecce',
      null, null, 'origine'
    ],
    [
      'Via G. Boccaccio 61 lecce',
      'Via G. Boccaccio 61, lecce, Italia',
      lecce, '075035', 'Lecce',
      null, null, 'destinazione'
    ],
    [
      'Via della Vite 12 Castromediano',
      'Via della Vite 12, Castromediano, Italia',
      castromediano, '075020', 'Cavallino',
      124, 'Castromediano', 'origine'
    ],
    [
      'Via Regina Elena 5 Giuliano di Lecce',
      'Via Regina Elena 5, Giuliano di Lecce, Italia',
      giuliano, '075019', 'Castrignano del Capo',
      232, 'Giuliano', 'destinazione'
    ],
    [
      'Via Gioacchino Toma 8 Santa Maria di Leuca',
      'Via Gioacchino Toma 8, Santa Maria di Leuca, Italia',
      leuca, '075019', 'Castrignano del Capo',
      429, 'Leuca', 'origine'
    ],
    [
      'Via Boccaccio 61/A Lecce',
      'Via Boccaccio 61/A, Lecce, Italia',
      lecce, '075035', 'Lecce',
      null, null, 'destinazione'
    ]
  ];

  for (const [
    indirizzoV17,
    normalizzato,
    coordinate,
    codice,
    comuneAtteso,
    gid,
    localita,
    ruolo
  ] of [...positiviV17, ...positiviV173]) {

    await test(
      'V17 persistenza: ' + indirizzoV17,
      async () => {

        await prepara(
          indirizzoV17,
          'DA_ELABORARE',
          ruolo
        );

        const prima = await leggi();
        const numeroScritture = scritture;

        const r = await conferma(
          indirizzoV17,
          coordinate,
          { ruolo }
        );

        const salvato = await leggi();
        const d = salvato[ruolo + '_dettaglio_geo'];

        assert.equal(
          scritture,
          numeroScritture + 1
        );

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
          salvato[ruolo],
          indirizzoV17
        );

        assert.equal(
          r.normalizzato,
          normalizzato
        );

        assert.equal(
          salvato[ruolo + '_normalizzata'],
          normalizzato
        );

        assert.equal(
          d.separatoreTerritorialeInferito,
          true
        );

        assert.equal(
          d.precisioneTerritoriale,
          gid === null ? 'COMUNE' : 'LOCALITA'
        );

        assert.equal(
          d.comuneAmministrativo,
          comuneAtteso
        );

        assert.equal(
          d.codiceIstatComune,
          codice
        );

        assert.equal(d.localita, localita);

        assert.equal(
          d.localitaGid === null
            ? null
            : Number(d.localitaGid),
          gid
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

        for (const chiave of Object.keys(prima)) {
          if (
            chiave === altro ||
            chiave.startsWith(altro + '_')
          ) {
            assert.deepEqual(
              salvato[chiave],
              prima[chiave],
              'Modifica inattesa: ' + chiave
            );
          }
        }
      }
    );
  }

  const negativiV17 = [
    [
      'Localita ambigua',
      'Via Roma 12 Casalabate',
      lecce
    ],
    [
      'Comune assente',
      'Via Roma 12',
      lecce
    ],
    [
      'Nome strada uguale al comune',
      'Via Lecce',
      lecce
    ],
    [
      'Comune inesistente',
      'Via Roma 12 Comune Inesistente',
      lecce
    ],
    [
      'Fuori frazione',
      'Via della Vite 12 Castromediano',
      fuoriCastromediano
    ],
    [
      'Fuori comune',
      'Via della Vite 12 Castromediano',
      lecce
    ]
  ];

  for (const [
    nome,
    indirizzoV17,
    coordinate
  ] of negativiV17) {

    await test('V17 rifiuto: ' + nome, async () => {
      await prepara(indirizzoV17);

      await rifiuto(
        indirizzoV17,
        coordinate,
        400
      );
    });
  }

  await test(
    'V17 indirizzo originale modificato',
    async () => {
      await prepara('Via Boccaccio 61 lecce');

      await rifiuto(
        'Via Boccaccio 61, lecce',
        lecce,
        409
      );
    }
  );


  const negativiV173 = [
    [
      'Localita ambigua senza civico',
      'Via Roma Casalabate',
      lecce
    ],
    [
      'Strada inesistente senza civico',
      'Via Zzxqinesistente Lecce',
      lecce
    ],
    [
      'Riferimento territoriale ambiguo',
      'Via Roma vicino Lecce',
      lecce
    ],
    [
      'Strada disconnessa',
      'Via Altair Brindisi',
      brindisi
    ],
    [
      'Strada ambigua',
      'Via Rossini Putignano',
      putignano
    ],
    [
      'Fuori localita inferita',
      'Via della Vite Castromediano',
      fuoriCastromediano
    ],
    [
      'Fuori comune inferito',
      'Via Boccaccio Lecce',
      castromediano
    ]
  ];

  for (const [
    nome,
    indirizzoV173,
    coordinate
  ] of negativiV173) {

    await test(
      'V173 rifiuto: ' + nome,
      async () => {
        await prepara(indirizzoV173);

        await rifiuto(
          indirizzoV173,
          coordinate,
          400
        );
      }
    );
  }

  await test(
    'V173 indirizzo originale modificato',
    async () => {
      await prepara('Via Boccaccio Lecce');

      await rifiuto(
        'Via Boccaccio, Lecce',
        lecce,
        409
      );
    }
  );


  const casiV184 = [
  {
    "indirizzo": "autostrada adriatica Acquaviva delle Fonti",
    "comune": "Acquaviva delle Fonti"
  },
  {
    "indirizzo": "autostrada adriatica Andria",
    "comune": "Andria"
  },
  {
    "indirizzo": "autostrada adriatica Apricena",
    "comune": "Apricena"
  },
  {
    "indirizzo": "autostrada dei due mari Ascoli Satriano",
    "comune": "Ascoli Satriano"
  },
  {
    "indirizzo": "autostrada adriatica Bitonto",
    "comune": "Bitonto"
  },
  {
    "indirizzo": "strada statale 613 brindisi lecce Brindisi",
    "comune": "Brindisi"
  },
  {
    "indirizzo": "strada statale 7 appia Brindisi",
    "comune": "Brindisi"
  },
  {
    "indirizzo": "autostrada adriatica Canosa di Puglia",
    "comune": "Canosa di Puglia"
  },
  {
    "indirizzo": "egnazia e delle terme di torre canne Carovigno",
    "comune": "Carovigno"
  },
  {
    "indirizzo": "strada statale 106 jonica Castellaneta",
    "comune": "Castellaneta"
  },
  {
    "indirizzo": "strada statale 16 adriatica Cavallino",
    "comune": "Cavallino"
  },
  {
    "indirizzo": "autostrada adriatica Chieuti",
    "comune": "Chieuti"
  },
  {
    "indirizzo": "strada provinciale 231 andriese coratina Corato",
    "comune": "Corato"
  },
  {
    "indirizzo": "strada statale 172 dei trulli Crispiano",
    "comune": "Crispiano"
  },
  {
    "indirizzo": "strada statale 379 egnazia e delle terme di torre canne Fasano",
    "comune": "Fasano"
  },
  {
    "indirizzo": "strada statale 101 salentina di gallipoli Galatina",
    "comune": "Galatina"
  },
  {
    "indirizzo": "strada statale 101 salentina di gallipoli Galatone",
    "comune": "Galatone"
  },
  {
    "indirizzo": "strada statale 106 jonica Ginosa",
    "comune": "Ginosa"
  },
  {
    "indirizzo": "autostrada adriatica Gioia del Colle",
    "comune": "Gioia del Colle"
  },
  {
    "indirizzo": "autostrada adriatica Giovinazzo",
    "comune": "Giovinazzo"
  },
  {
    "indirizzo": "strada statale 16 adriatica Giurdignano",
    "comune": "Giurdignano"
  },
  {
    "indirizzo": "strada statale 7 appia Latiano",
    "comune": "Latiano"
  },
  {
    "indirizzo": "strada provinciale del lido di lecce Lecce",
    "comune": "Lecce"
  },
  {
    "indirizzo": "autostrada adriatica Lesina",
    "comune": "Lesina"
  },
  {
    "indirizzo": "strada statale 106 jonica Massafra",
    "comune": "Massafra"
  },
  {
    "indirizzo": "strada statale 7 appia Mesagne",
    "comune": "Mesagne"
  },
  {
    "indirizzo": "strada statale 16 adriatica Mola di Bari",
    "comune": "Mola di Bari"
  },
  {
    "indirizzo": "strada statale 16 adriatica Monopoli",
    "comune": "Monopoli"
  },
  {
    "indirizzo": "autostrada adriatica Mottola",
    "comune": "Mottola"
  },
  {
    "indirizzo": "autostrada adriatica Orta Nova",
    "comune": "Orta Nova"
  },
  {
    "indirizzo": "autostrada adriatica Palagiano",
    "comune": "Palagiano"
  },
  {
    "indirizzo": "strada statale 106 jonica Palagiano",
    "comune": "Palagiano"
  },
  {
    "indirizzo": "strada provinciale 231 andriese coratina Ruvo di Puglia",
    "comune": "Ruvo di Puglia"
  },
  {
    "indirizzo": "strada statale 16 adriatica San Ferdinando di Puglia",
    "comune": "San Ferdinando di Puglia"
  },
  {
    "indirizzo": "autostrada adriatica Sannicandro di Bari",
    "comune": "Sannicandro di Bari"
  },
  {
    "indirizzo": "autostrada adriatica San Severo",
    "comune": "San Severo"
  },
  {
    "indirizzo": "strada statale 96 barese Toritto",
    "comune": "Toritto"
  },
  {
    "indirizzo": "strada statale 16 adriatica Trani",
    "comune": "Trani"
  }
];

  for (const caso of casiV184) {
    await test('V184 rifiuto carreggiata: ' + caso.indirizzo, async () => {
      const { rows } = await db.query(
        'SELECT ST_Y(ST_PointOnSurface(geom)) AS lat, ST_X(ST_PointOnSurface(geom)) AS lon FROM public.pixel_confini_comunali WHERE nome_comune = $1',
        [caso.comune]
      );
      assert.equal(rows.length, 1);
      await prepara(caso.indirizzo);
      await rifiuto(caso.indirizzo, rows[0], 400);
    });
  }

  await test('Nessuna autorizzazione API esterna', async () => {
    assert.equal(chiamateEsterne, 0);
  });


  assert.equal(
    risultati.length, 87,
    'Numero test V173 inatteso'
  );

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
        pg_temp.test_ncc_v184,
        pg_temp.test_ncc_gruppi_v184
    `);

    console.log('PULIZIA TABELLE TEMPORANEE OK');

  } finally {
    db.release();
    await pool.end();
  }
}