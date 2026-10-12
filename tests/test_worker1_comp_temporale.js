
import assert from 'node:assert/strict';
import { pool } from '../db/db.js';

// Diagnostica POPBUS: esclusivamente SELECT in transazione READ ONLY.
const TOLLERANZA_MINUTI = 30;
const LIMITE_RICHIESTE = 1000;
const LIMITE_DIRETTRICI = 100;
const LIMITE_SEGMENTI = 1000;
const LIMITE_OUTPUT = 30;

const SCENARI = [
  { nome: 'Principale', start: 1, end: 4, datetime: '2026-10-12T17:00:00.000Z', posti: 2 },
  { nome: 'Intermedia', start: 3, end: 4, datetime: '2026-10-12T17:05:00.000Z', posti: 1 },
  { nome: 'Distante', start: 2, end: 4, datetime: '2026-10-12T18:30:00.000Z', posti: 1 }
];

const minuti = (a, b) =>
  Math.abs(new Date(a) - new Date(b)) / 60000;

const num = v => v == null ? null : Number(v);

const report = (titolo, righe) => {
  console.log(`\n${titolo}: ${righe.length}`);
  if (righe.length) console.table(righe.slice(0, LIMITE_OUTPUT));
  if (righe.length > LIMITE_OUTPUT) {
    console.log(`… altre ${righe.length - LIMITE_OUTPUT} righe non mostrate`);
  }
};

const anomalie = [];
const avvisa = (codice, dettagli) =>
  anomalie.push({ codice, ...dettagli });

async function schema(client) {
  const { rows } = await client.query(`
    SELECT table_name, column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name IN (
        'richieste_pop_bus',
        'direttrici_virtuali',
        'segmenti'
      )
    ORDER BY table_name, ordinal_position
  `);

  const cols = new Map();

  for (const r of rows) {
    if (!cols.has(r.table_name)) {
      cols.set(r.table_name, new Set());
    }
    cols.get(r.table_name).add(r.column_name);
  }

  const has = (table, column) =>
    cols.get(table)?.has(column) ?? false;

  const required = {
    richieste_pop_bus: [
      'id', 'direttrice_id', 'start_node_id',
      'end_node_id', 'start_datetime'
    ],
    direttrici_virtuali: [
      'id', 'start_node_id', 'end_node_id',
      'partenza_prevista'
    ],
    segmenti: [
      'id', 'direttrice_id', 'start_node_id',
      'end_node_id', 'ordine_sequenziale',
      'posti_occupati'
    ]
  };

  for (const [table, names] of Object.entries(required)) {
    for (const name of names) {
      assert.ok(
        has(table, name),
        `Colonna obbligatoria mancante: ${table}.${name}`
      );
    }
  }

  console.log('\n📋 Colonne rilevate');
  console.table(rows);

  return { has, cols };
}

async function queryTabella(
  client, table, fields, where, order, limit
) {
  // Identificatori costruiti solo da costanti e nomi
  // verificati nello schema.
  const sql = `
    SELECT ${fields.join(', ')}
    FROM ${table}
    ${where}
    ORDER BY ${order}
    LIMIT $1
  `;

  return (await client.query(sql, [limit])).rows;
}

function verificaScenari() {
  const [a, b, c] = SCENARI;

  assert.ok(
    minuti(a.datetime, b.datetime) <= TOLLERANZA_MINUTI
  );

  assert.ok(
    minuti(a.datetime, c.datetime) > TOLLERANZA_MINUTI
  );

  console.table([
    {
      confronto: '1 / 2',
      differenza_minuti: minuti(a.datetime, b.datetime),
      entro_finestra: true
    },
    {
      confronto: '1 / 3',
      differenza_minuti: minuti(a.datetime, c.datetime),
      entro_finestra: false
    }
  ]);

  console.log(
    '⚠️ La tolleranza tra partenze non equivale ' +
    'alla compatibilità al nodo di salita.'
  );
}

function verificaPercorsi(
  direttrici, segmenti, richieste, has
) {
  const perDirettrice = new Map();

  for (const s of segmenti) {
    const key = String(s.direttrice_id);

    if (!perDirettrice.has(key)) {
      perDirettrice.set(key, []);
    }

    perDirettrice.get(key).push(s);
  }

  const dirs = new Map(
    direttrici.map(d => [String(d.id), d])
  );

  let percorsiCompleti = 0;

  for (const d of direttrici) {
    const seg = perDirettrice.get(String(d.id)) ?? [];

    if (!seg.length) {
      avvisa('DIRETTRICE_SENZA_SEGMENTI', {
        direttrice_id: d.id
      });
      continue;
    }

    seg.sort(
      (a, b) =>
        Number(a.ordine_sequenziale) -
        Number(b.ordine_sequenziale)
    );

    let valido = true;
    const ordini = new Set();

    for (let i = 0; i < seg.length; i++) {
      const s = seg[i];
      const ordine = num(s.ordine_sequenziale);

      if (
        ordine === null ||
        !Number.isFinite(ordine) ||
        ordini.has(ordine)
      ) {
        avvisa('ORDINE_SEGMENTI_INVALIDO', {
          direttrice_id: d.id,
          segmento_id: s.id,
          ordine
        });
        valido = false;
      }

      ordini.add(ordine);

      if (
        String(s.start_node_id) ===
        String(s.end_node_id)
      ) {
        avvisa('SEGMENTO_CIRCOLARE', {
          direttrice_id: d.id,
          segmento_id: s.id
        });
        valido = false;
      }

      if (
        i &&
        String(seg[i - 1].end_node_id) !==
        String(s.start_node_id)
      ) {
        avvisa('DISCONTINUITA_PERCORSO', {
          direttrice_id: d.id,
          segmento_precedente: seg[i - 1].id,
          segmento_successivo: s.id
        });
        valido = false;
      }
    }

    if (
      String(seg[0].start_node_id) !==
        String(d.start_node_id) ||
      String(seg.at(-1).end_node_id) !==
        String(d.end_node_id)
    ) {
      avvisa('ESTREMI_DIRETTRICE_NON_COINCIDENTI', {
        direttrice_id: d.id
      });
      valido = false;
    }

    if (valido) percorsiCompleti++;
  }

  for (const r of richieste) {
    if (r.direttrice_id == null) continue;

    const d = dirs.get(String(r.direttrice_id));

    if (!d) {
      // Non prova che la direttrice sia inesistente:
      // la lista delle direttrici è campionata.
      avvisa('DIRETTRICE_NON_PRESENTE_NEL_CAMPIONE', {
        richiesta_id: r.id,
        direttrice_id: r.direttrice_id
      });
      continue;
    }

    const seg = perDirettrice.get(String(d.id));

    if (!seg?.length) continue;

    const ordered = [...seg].sort(
      (a, b) =>
        Number(a.ordine_sequenziale) -
        Number(b.ordine_sequenziale)
    );

    const starts = ordered.map((s, i) => ({
      id: String(s.start_node_id),
      index: i
    }));

    const ends = ordered.map((s, i) => ({
      id: String(s.end_node_id),
      index: i
    }));

    const valid = starts.some(
      a =>
        a.id === String(r.start_node_id) &&
        ends.some(
          b =>
            b.id === String(r.end_node_id) &&
            a.index <= b.index
        )
    );

    if (!valid) {
      avvisa('RICHIESTA_NON_PERCORRIBILE_NEL_CAMPIONE', {
        richiesta_id: r.id,
        direttrice_id: d.id
      });
    }
  }

  console.log(
    `Percorsi coerenti nel campione: ` +
    `${percorsiCompleti}/${direttrici.length}`
  );
}

function verificaCapienza(segmenti, has) {
  for (const s of segmenti) {
    for (const field of [
      'posti_occupati',
      'posti_impegnati'
    ]) {
      if (!has('segmenti', field)) continue;

      const v = num(s[field]);

      if (
        v === null ||
        !Number.isInteger(v) ||
        v < 0
      ) {
        avvisa('CONTATORE_POSTI_INVALIDO', {
          segmento_id: s.id,
          campo: field,
          valore: s[field]
        });
      }
    }
  }

  console.log(
    'ℹ️ Capienza massima e semantica ' +
    'occupati/impegnati non deducibili automaticamente: ' +
    'nessuna certificazione di overbooking.'
  );
}

async function controlliGlobali(client, has) {
  // Query sull'intera tabella,
  // indipendenti dal campionamento.

  const { rows: orphan } = await client.query(`
    SELECT COUNT(*)::int AS totale
    FROM richieste_pop_bus r
    LEFT JOIN direttrici_virtuali d
      ON d.id = r.direttrice_id
    WHERE r.direttrice_id IS NOT NULL
      AND d.id IS NULL
  `);

  if (orphan[0].totale) {
    avvisa('RICHIESTE_CON_DIRETTRICE_INESISTENTE', {
      totale: orphan[0].totale
    });
  }

  const { rows: senzaSegmenti } = await client.query(`
    SELECT COUNT(*)::int AS totale
    FROM direttrici_virtuali d
    WHERE EXISTS (
      SELECT 1
      FROM richieste_pop_bus r
      WHERE r.direttrice_id = d.id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM segmenti s
      WHERE s.direttrice_id = d.id
    )
  `);

  if (senzaSegmenti[0].totale) {
    avvisa(
      'DIRETTRICI_CON_RICHIESTE_SENZA_SEGMENTI',
      { totale: senzaSegmenti[0].totale }
    );
  }

  console.table([
    {
      controllo: 'Richieste con direttrice inesistente',
      totale: orphan[0].totale
    },
    {
      controllo: 'Direttrici con richieste senza segmenti',
      totale: senzaSegmenti[0].totale
    }
  ]);
}

async function main() {
  let client;
  let transaction = false;

  try {
    console.log(
      '🚌 TURENTU POPBUS — ' +
      'DIAGNOSTICA AVANZATA, SOLA LETTURA'
    );

    verificaScenari();

    client = await pool.connect();

    await client.query(
      'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'
    );

    transaction = true;

    await client.query(
      "SET LOCAL statement_timeout = '15000ms'"
    );

    const { rows: db } = await client.query(`
      SELECT
        current_database() AS database,
        current_user AS utente,
        current_setting('transaction_read_only') AS sola_lettura
    `);

    console.table(db);

    assert.equal(db[0].sola_lettura, 'on');

    const { has } = await schema(client);

    const df = [
      'id',
      'start_node_id',
      'end_node_id',
      'partenza_prevista',
      ...(has('direttrici_virtuali', 'stato')
        ? ['stato']
        : [])
    ];

    const rf = [
      'id',
      'start_node_id',
      'end_node_id',
      'start_datetime',
      'direttrice_id',
      ...(has('richieste_pop_bus', 'stato')
        ? ['stato']
        : []),
      ...(has('richieste_pop_bus', 'posti_richiesti')
        ? ['posti_richiesti']
        : [])
    ];

    const sf = [
      'id',
      'direttrice_id',
      'start_node_id',
      'end_node_id',
      'ordine_sequenziale',
      'posti_occupati',
      ...(has('segmenti', 'posti_impegnati')
        ? ['posti_impegnati']
        : [])
    ];

    const direttrici = await queryTabella(
      client,
      'direttrici_virtuali',
      df,
      '',
      'partenza_prevista DESC NULLS LAST, id DESC',
      LIMITE_DIRETTRICI
    );

    const richieste = await queryTabella(
      client,
      'richieste_pop_bus',
      rf,
      'WHERE direttrice_id IS NOT NULL',
      'start_datetime DESC NULLS LAST, id DESC',
      LIMITE_RICHIESTE
    );

    const segmenti = await queryTabella(
      client,
      'segmenti',
      sf,
      '',
      'direttrice_id, ordine_sequenziale, id',
      LIMITE_SEGMENTI
    );

    report('🚌 Direttrici campionate', direttrici);
    report('📊 Richieste campionate', richieste);
    report('📏 Segmenti campionati', segmenti);

    verificaPercorsi(
      direttrici,
      segmenti,
      richieste,
      has
    );

    verificaCapienza(segmenti, has);

    await controlliGlobali(client, has);

    const dirs = new Map(
      direttrici.map(d => [String(d.id), d])
    );

    const scostamenti = richieste
      .filter(r => {
        const d = dirs.get(String(r.direttrice_id));

        return (
          d?.partenza_prevista &&
          r.start_datetime &&
          minuti(
            r.start_datetime,
            d.partenza_prevista
          ) > TOLLERANZA_MINUTI
        );
      })
      .map(r => ({
        richiesta_id: r.id,
        direttrice_id: r.direttrice_id,
        scostamento_minuti: minuti(
          r.start_datetime,
          dirs.get(String(r.direttrice_id))
            .partenza_prevista
        )
      }));

    report(
      '⏱️ Scostamenti >30 min dalla partenza ' +
      'generale (NON errori certi)',
      scostamenti
    );

    report(
      '⚠️ Anomalie e limiti rilevati',
      anomalie
    );

    console.table([
      {
        direttrici: direttrici.length,
        richieste: richieste.length,
        segmenti: segmenti.length,
        anomalie: anomalie.length,
        scostamenti_teorici: scostamenti.length
      }
    ]);

    console.log(
      '⚠️ I campioni indipendenti possono essere ' +
      'incompleti: le anomalie di percorso nel ' +
      'campione richiedono conferma.'
    );

    console.log(
      '⚠️ Mancano orari di passaggio per nodo, ' +
      'durata tratta e capacità effettiva: ' +
      'matching reale NON certificato.'
    );

    console.log('🔒 Nessuna modifica ai dati.');

    if (anomalie.length) {
      process.exitCode = 2;
    }

  } catch (err) {
    console.error(
      '❌ Diagnostica fallita:',
      err.stack ?? err
    );

    process.exitCode = 1;

  } finally {
    if (client) {
      if (transaction) {
        try {
          await client.query('ROLLBACK');
        } catch (err) {
          console.error('Rollback fallito:', err);
          process.exitCode = 1;
        }
      }

      client.release();
    }

    await pool.end();
  }
}

main();
