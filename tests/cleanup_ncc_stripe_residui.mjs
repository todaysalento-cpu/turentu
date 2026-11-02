
import fs from 'node:fs';
import crypto from 'node:crypto';
import { pool } from '../db/db.js';

const FILE = 'tests/ncc_stripe_residui_919_920_921_full.json';
const HASH = '6239aeb692161969f1e555a9202a796b1f48654fbd4c39817e5e82fc4f8e7779';
const COMMIT = process.argv.includes('--commit');

const expectedCounts = {
  corse: 3,
  tratte: 3,
  prenotazioni: 9,
  pagamenti: 9
};

const quote = x => '"' + String(x).replaceAll('"', '""') + '"';
const qualified = (schema, table) => quote(schema) + '.' + quote(table);

function normalize(v) {
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = normalize(v[k]);
    return out;
  }
  return v;
}

function same(a, b) {
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

function requireCount(rows, n, label) {
  if (rows.length !== n) {
    throw new Error(`${label}: attesi ${n}, trovati ${rows.length}`);
  }
}

function relationKey(child, childCols, parent, parentCols) {
  return [
    child,
    childCols.join(','),
    parent,
    parentCols.join(',')
  ].join('|');
}

// Le sole relazioni interne ammesse.
// Tutte le altre devono avere zero riferimenti.
const allowed = new Map([
  ['corse_tratte|corsa_id|corse|id', { count: 3, occurrences: 1 }],
  ['prenotazioni|corsa_id|corse|id', { count: 9, occurrences: 1 }],
  ['prenotazioni|tratta_id,corsa_id|corse_tratte|id,corsa_id',
    { count: 9, occurrences: 1 }],
  ['pagamenti|prenotazione_id|prenotazioni|id',
    { count: 9, occurrences: 2 }]
]);

const bytes = fs.readFileSync(FILE);
const hash = crypto.createHash('sha256').update(bytes).digest('hex');

if (hash !== HASH) throw new Error('BACKUP SHA256 NON VALIDO');

const backup = JSON.parse(bytes.toString('utf8'));

for (const [key, count] of Object.entries(expectedCounts)) {
  requireCount(backup[key], count, `BACKUP ${key}`);
}

const rideIds = backup.corse.map(x => Number(x.id));
const trattaIds = backup.tratte.map(x => Number(x.id));
const bookingIds = backup.prenotazioni.map(x => Number(x.id));
const paymentIds = backup.pagamenti.map(x => Number(x.id));

if (!same(rideIds.slice().sort((a,b)=>a-b), [919,920,921])) {
  throw new Error('ID CORSE NON PREVISTI');
}

if (!same(trattaIds.slice().sort((a,b)=>a-b), [7,8,9])) {
  throw new Error('ID TRATTE NON PREVISTI');
}

if (!same(bookingIds.slice().sort((a,b)=>a-b),
  [1079,1080,1081,1082,1083,1084,1085,1086,1087])) {
  throw new Error('ID PRENOTAZIONI NON PREVISTI');
}

if (!same(paymentIds.slice().sort((a,b)=>a-b),
  [609,610,611,612,613,614,615,616,617])) {
  throw new Error('ID PAGAMENTI NON PREVISTI');
}

if (backup.corse.some(x =>
  !String(x.origine_address).startsWith('TURENTU_NCC_STRIPE_TEST_')
)) throw new Error('MARKER NON VALIDO');

if (backup.pagamenti.some(x => !x.stripe_payment_intent)) {
  throw new Error('PAYMENT INTENT ASSENTE');
}

const targetIds = new Map([
  ['corse', rideIds],
  ['corse_tratte', trattaIds],
  ['prenotazioni', bookingIds],
  ['pagamenti', paymentIds]
]);

// Mappatura tabella DB -> chiave corrispondente nel backup.
const tables = [
  ['corse', 'corse'],
  ['corse_tratte', 'tratte'],
  ['prenotazioni', 'prenotazioni'],
  ['pagamenti', 'pagamenti']
];

const c = await pool.connect();
let transaction = false;

try {
  await c.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  transaction = true;

  await c.query("SET LOCAL lock_timeout='5s'");
  await c.query("SET LOCAL statement_timeout='60s'");

  // 1. Verifica tutte le FK reali presenti nello schema.
  const fkResult = await c.query(`
    SELECT
      pc.conname,
      child_ns.nspname AS child_schema,
      child.relname AS child_table,
      parent_ns.nspname AS parent_schema,
      parent.relname AS parent_table,
json_agg(child_att.attname ORDER BY ck.ord) AS child_columns,
json_agg(parent_att.attname ORDER BY ck.ord) AS parent_columns
    FROM pg_constraint pc
    JOIN pg_class child ON child.oid = pc.conrelid
    JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
    JOIN pg_class parent ON parent.oid = pc.confrelid
    JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
    JOIN LATERAL unnest(pc.conkey)
      WITH ORDINALITY ck(attnum, ord) ON true
    JOIN LATERAL unnest(pc.confkey)
      WITH ORDINALITY pk(attnum, ord) ON pk.ord = ck.ord
    JOIN pg_attribute child_att
      ON child_att.attrelid = child.oid
     AND child_att.attnum = ck.attnum
    JOIN pg_attribute parent_att
      ON parent_att.attrelid = parent.oid
     AND parent_att.attnum = pk.attnum
    WHERE pc.contype = 'f'
      AND pc.confrelid IN (
        'public.corse'::regclass,
        'public.corse_tratte'::regclass,
        'public.prenotazioni'::regclass,
        'public.pagamenti'::regclass
      )
    GROUP BY pc.oid, pc.conname, child_ns.nspname,
      child.relname, parent_ns.nspname, parent.relname
    ORDER BY child_ns.nspname, child.relname, pc.conname
  `);

  // Blocca in modo deterministico tutte le tabelle coinvolte nelle FK
  // verso le quattro tabelle target. SHARE impedisce DML concorrente
  // durante preflight e cancellazione, senza bloccare le normali SELECT.
  const lockTargets = new Map();
  for (const fk of fkResult.rows) {
    lockTargets.set(
      `${fk.child_schema}.${fk.child_table}`,
      { schema: fk.child_schema, table: fk.child_table }
    );
    lockTargets.set(
      `${fk.parent_schema}.${fk.parent_table}`,
      { schema: fk.parent_schema, table: fk.parent_table }
    );
  }
  for (const [table] of tables) {
    lockTargets.set(`public.${table}`, { schema: 'public', table });
  }

  const orderedLocks = [...lockTargets.values()].sort((a, b) =>
    `${a.schema}.${a.table}`.localeCompare(`${b.schema}.${b.table}`)
  );

  for (const item of orderedLocks) {
    await c.query(
      `LOCK TABLE ${qualified(item.schema, item.table)} IN SHARE MODE`
    );
  }
  console.log(`PASS lock tabelle coinvolte: ${orderedLocks.length}`);

  // Blocca e confronta integralmente ogni riga target con il backup.
  const integrityChecks = [
    ['corse', 'corse', rideIds],
    ['corse_tratte', 'tratte', trattaIds],
    ['prenotazioni', 'prenotazioni', bookingIds],
    ['pagamenti', 'pagamenti', paymentIds]
  ];

  for (const [table, backupKey, ids] of integrityChecks) {
    const result = await c.query(
      `SELECT * FROM public.${table}
       WHERE id=ANY($1::int[])
       ORDER BY id
       FOR UPDATE`,
      [ids]
    );

    requireCount(result.rows, expectedCounts[backupKey], `INTEGRITA ${table}`);

    const expectedRows = backup[backupKey].slice().sort(
      (a, b) => Number(a.id) - Number(b.id)
    );

    if (!same(result.rows, expectedRows)) {
      throw new Error(`BACKUP DIVERSO: ${table}`);
    }

    console.log(`PASS integrita ${table}: ${result.rows.length}`);
  }

  // 4. Verifica identità e marker.
  const users = await c.query(
    'SELECT id FROM public.utente WHERE id=ANY($1::int[]) ORDER BY id',
    [[1,2,3]]
  );

  if (!same(users.rows.map(x => Number(x.id)), [1,2,3])) {
    throw new Error('UTENTI ORIGINALI NON INTEGRI');
  }

  const rides = await c.query(
    `SELECT id, origine_address FROM public.corse
     WHERE id=ANY($1::int[])`,
    [rideIds]
  );

  if (rides.rows.some(x =>
    !String(x.origine_address).startsWith('TURENTU_NCC_STRIPE_TEST_')
  )) throw new Error('MARKER DATABASE NON VALIDO');

  console.log('PASS utenti originali');
  console.log('PASS marker corse');

  // 5. Verifica dinamica di TUTTE le FK.
  const occurrences = new Map();

  for (const fk of fkResult.rows) {
    const parentIds = targetIds.get(fk.parent_table);

    if (!parentIds) {
      throw new Error(`TABELLA PADRE NON PREVISTA: ${fk.parent_table}`);
    }

    if (!fk.parent_columns.includes('id')) {
      throw new Error(`CHIAVE PADRE SENZA ID: ${fk.conname}`);
    }

    const childColumns = fk.child_columns;
    const parentColumns = fk.parent_columns;

    if (!Array.isArray(childColumns) ||
        !Array.isArray(parentColumns) ||
        childColumns.length === 0 ||
        childColumns.length !== parentColumns.length) {
      throw new Error(`DEFINIZIONE FK NON VALIDA: ${fk.conname}`);
    }

    if (!parentColumns.includes('id')) {
      throw new Error(`CHIAVE PADRE SENZA ID: ${fk.conname}`);
    }

    const join = childColumns.map((column, i) =>
      `ch.${quote(column)} = pa.${quote(parentColumns[i])}`
    ).join(' AND ');

    const sql = `
      SELECT count(*)::int AS n
      FROM ${qualified(fk.child_schema, fk.child_table)} ch
      JOIN ${qualified(fk.parent_schema, fk.parent_table)} pa
        ON ${join}
      WHERE pa.id=ANY($1::int[])
    `;

    const result = await c.query(sql, [parentIds]);
    const actual = Number(result.rows[0].n);

    const signature = relationKey(
      fk.child_table,
      childColumns,
      fk.parent_table,
      parentColumns
    );

    const rule = allowed.get(signature);
    const expected = rule ? rule.count : 0;

    if (actual !== expected) {
      throw new Error(
        `FK BLOCCANTE ${fk.conname}: attesi ${expected}, trovati ${actual}`
      );
    }

    if (rule) {
      occurrences.set(signature, (occurrences.get(signature) || 0) + 1);
    }

    console.log(
      `PASS FK ${fk.conname}: ${actual} riferimenti`
    );
  }

  for (const [signature, rule] of allowed) {
    if ((occurrences.get(signature) || 0) !== rule.occurrences) {
      throw new Error(`FK INTERNA ATTESA ASSENTE O DUPLICATA: ${signature}`);
    }
  }

  console.log('PASS tutte le FK dinamiche');
  console.log('PASS FK composte');
  console.log('PASS nessuna dipendenza esterna');

  // 6. Verifica esatta dei nove pagamenti.
  const payments = await c.query(
    `SELECT * FROM public.pagamenti
     WHERE prenotazione_id=ANY($1::int[])
     ORDER BY id`,
    [bookingIds]
  );

  if (!same(
    payments.rows,
    backup.pagamenti.slice().sort(
      (a,b)=>Number(a.id)-Number(b.id)
    )
  )) throw new Error('PAGAMENTI DIVERSI DAL BACKUP');

  console.log('PASS pagamenti riconciliati');
  console.log('PASS backup SHA256');

  if (!COMMIT) {
    console.log('\nDRY RUN SUPERATO');
    console.log('24 record verificati.');
    console.log('Nessuna cancellazione richiesta.');
  } else {
    // 7. Cancellazione esplicita nell'ordine FK.
    const deletions = [
      ['pagamenti', paymentIds, 9],
      ['prenotazioni', bookingIds, 9],
      ['corse_tratte', trattaIds, 3],
      ['corse', rideIds, 3]
    ];

    for (const [table, ids, expected] of deletions) {
      const result = await c.query(
        `DELETE FROM public.${table}
         WHERE id=ANY($1::int[]) RETURNING id`,
        [ids]
      );

      requireCount(result.rows, expected, `DELETE ${table}`);
      console.log(`PASS DELETE ${table}: ${result.rowCount}`);
    }

    // 8. Verifica finale nella stessa transazione.
    for (const [table, key] of tables) {
      const result = await c.query(
        `SELECT count(*)::int AS n FROM public.${table}
         WHERE id=ANY($1::int[])`,
        [backup[key].map(x => Number(x.id))]
      );

      if (result.rows[0].n !== 0) {
        throw new Error(`RECORD RESIDUI IN ${table}`);
      }
    }

    await c.query('COMMIT');
    transaction = false;

    console.log('\nCOMMIT COMPLETATO');
    console.log('24 record eliminati.');
    console.log('Nessuna chiamata Stripe effettuata.');
  }

} catch (e) {
  console.error('\nOPERAZIONE BLOCCATA:', e.message);
  process.exitCode = 1;

} finally {
  if (transaction) {
    await c.query('ROLLBACK').catch(() => {});
    console.log('ROLLBACK ESEGUITO');
  }

  c.release();
  await pool.end();
}
