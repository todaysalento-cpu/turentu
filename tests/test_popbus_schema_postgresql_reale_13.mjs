// TURENTU POPBUS V2 — TEST 13: AUDIT SCHEMA POSTGRESQL REALE
// Modalita': SOLA LETTURA. Nessuna modifica a schema o dati.
// Salva come: tests/test_popbus_schema_postgresql_reale_13.mjs
// Esegui dalla root: node --env-file=.env tests/test_popbus_schema_postgresql_reale_13.mjs
// Riutilizza il pool esistente in db/db.js, senza richiedere DATABASE_URL.

import { pool } from '../db/db.js';

const TABLES = [
  'popbus_attivazioni', 'popbus_missioni', 'popbus_missione_richieste',
  'popbus_attivazione_richieste', 'corse', 'prenotazioni', 'pagamenti',
];
const IMPORTANT = [
  ['corse', 'id'], ['corse', 'veicolo_id'],
  ['popbus_attivazioni', 'id'],
  ['popbus_missioni', 'id'], ['popbus_missioni', 'attivazione_id'],
  ['popbus_missione_richieste', 'missione_id'],
  ['popbus_attivazione_richieste', 'attivazione_id'],
  ['popbus_attivazione_richieste', 'indice_salita'],
  ['popbus_attivazione_richieste', 'indice_discesa'],
  ['prenotazioni', 'corsa_id'], ['pagamenti', 'corsa_id'],
];
const state = { pass: 0, fail: 0, gap: 0 };
function check(label, ok, detail = '') {
  state[ok ? 'pass' : 'gap']++;
  console.log(`${ok ? 'PASS' : 'GAP '} ${label}${detail ? ' — ' + detail : ''}`);
}
function fail(label, err) { state.fail++; console.error('FAIL', label, '—', err?.message ?? String(err)); }
function printRows(title, rows, keys, max = 150) {
  console.log(`\n--- ${title} (${rows.length}) ---`);
  if (!rows.length) { console.log('(nessun risultato)'); return; }
  console.table(rows.slice(0, max).map(r => Object.fromEntries(keys.map(k => [k, r[k]]))));
  if (rows.length > max) console.log(`... altre ${rows.length - max} righe omesse`);
}

console.log('=== TURENTU POPBUS / TEST 13 SCHEMA POSTGRESQL REALE ===');
console.log('Modalita: transazione READ ONLY + ROLLBACK; nessuna modifica ai dati.');
// Riutilizza esattamente la connessione del backend Turentu.
{
  let client;
  let inTransaction = false;
  try {
    client = await pool.connect();
    await client.query('BEGIN READ ONLY');
    inTransaction = true;
    await client.query("SET LOCAL statement_timeout = '15000ms'");
    const meta = await client.query(`SELECT current_database() AS database, current_schema() AS schema,
      current_setting('transaction_read_only') AS read_only, version() AS postgres_version`);
    check('Connessione reale PostgreSQL', Boolean(meta.rows[0]?.database));
    check('Transazione READ ONLY attiva', meta.rows[0]?.read_only === 'on');
    console.log('DATABASE:', meta.rows[0].database, '| SCHEMA:', meta.rows[0].schema,
      '| READ ONLY:', meta.rows[0].read_only);

    const rels = await client.query(`SELECT c.relname AS tabella, c.relkind AS tipo,
      pg_get_userbyid(c.relowner) AS proprietario,
      obj_description(c.oid, 'pg_class') AS commento
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname = ANY($1::text[])
      ORDER BY c.relname`, [TABLES]);
    printRows('TABELLE RILEVATE', rels.rows, ['tabella','tipo','proprietario']);
    const present = new Set(rels.rows.map(r => r.tabella));
    for (const name of TABLES) check(`Tabella public.${name}`, present.has(name));

    const cols = await client.query(`SELECT table_name AS tabella, ordinal_position AS posizione,
      column_name AS colonna, data_type AS tipo, udt_name AS tipo_pg,
      is_nullable AS nullable, column_default AS default_valore,
      is_identity AS identity
      FROM information_schema.columns
      WHERE table_schema='public' AND table_name = ANY($1::text[])
      ORDER BY table_name, ordinal_position`, [TABLES]);
    printRows('COLONNE / TIPI / NULLABILITA / DEFAULT', cols.rows,
      ['tabella','posizione','colonna','tipo','tipo_pg','nullable','default_valore','identity'], 300);
    const columnsByTable = new Map();
    for (const r of cols.rows) {
      if (!columnsByTable.has(r.tabella)) columnsByTable.set(r.tabella, new Set());
      columnsByTable.get(r.tabella).add(r.colonna);
    }
    for (const [t,c] of IMPORTANT) check(`Colonna ${t}.${c}`, columnsByTable.get(t)?.has(c) ?? false);

    const constraints = await client.query(`SELECT rel.relname AS tabella, con.conname AS vincolo,
      CASE con.contype WHEN 'p' THEN 'PRIMARY KEY' WHEN 'f' THEN 'FOREIGN KEY'
        WHEN 'u' THEN 'UNIQUE' WHEN 'c' THEN 'CHECK' WHEN 'x' THEN 'EXCLUDE'
        ELSE con.contype::text END AS tipo,
      pg_get_constraintdef(con.oid, true) AS definizione
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid=con.conrelid
      JOIN pg_namespace ns ON ns.oid=rel.relnamespace
      WHERE ns.nspname='public' AND rel.relname=ANY($1::text[])
      ORDER BY rel.relname, con.contype, con.conname`, [TABLES]);
    printRows('VINCOLI (PK / FK / UNIQUE / CHECK / EXCLUDE)', constraints.rows,
      ['tabella','vincolo','tipo','definizione'], 300);

    const indexes = await client.query(`SELECT tablename AS tabella, indexname AS indice,
      indexdef AS definizione
      FROM pg_indexes WHERE schemaname='public' AND tablename=ANY($1::text[])
      ORDER BY tablename, indexname`, [TABLES]);
    printRows('INDICI', indexes.rows, ['tabella','indice','definizione'], 300);

    const fks = constraints.rows.filter(r => r.tipo === 'FOREIGN KEY');
    check('Almeno una FK nelle tabelle POPBUS', fks.some(r => r.tabella.startsWith('popbus_')));
    check('Almeno una FK da prenotazioni', fks.some(r => r.tabella === 'prenotazioni'));
    check('Almeno una FK da pagamenti', fks.some(r => r.tabella === 'pagamenti'));
    const idx = indexes.rows.filter(r => r.tabella === 'corse');
    check('Indici sulla tabella corse presenti', idx.length > 0);

    // Informazioni aggiuntive utili per capire se il DB puo' associare piu' missioni
    // a un'attivazione e piu' prenotazioni a una sola corsa.
    const links = await client.query(`SELECT tc.table_name AS tabella, tc.constraint_name AS vincolo,
      kcu.column_name AS colonna, ccu.table_name AS tabella_riferita,
      ccu.column_name AS colonna_riferita
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name=kcu.constraint_name AND tc.constraint_schema=kcu.constraint_schema
        AND tc.table_name=kcu.table_name
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name=tc.constraint_name AND ccu.constraint_schema=tc.constraint_schema
      WHERE tc.table_schema='public' AND tc.constraint_type='FOREIGN KEY'
        AND tc.table_name=ANY($1::text[])
      ORDER BY tc.table_name, tc.constraint_name, kcu.ordinal_position`, [TABLES]);
    printRows('RELAZIONI FOREIGN KEY', links.rows,
      ['tabella','colonna','tabella_riferita','colonna_riferita','vincolo'], 300);

    const report = {
      pass: state.pass, fail: state.fail, gap: state.gap,
      tabellePresenti: rels.rows.map(r => r.tabella),
      numeroColonne: cols.rows.length, numeroVincoli: constraints.rows.length,
      numeroIndici: indexes.rows.length,
      modalita: 'POSTGRESQL REALE / READ ONLY / ROLLBACK',
      nota: 'Audit strutturale: non dimostra correttezza di INSERT, acceptance o concorrenza.'
    };
    console.log('\nRIEPILOGO', JSON.stringify(report, null, 2));
  } catch (err) {
    fail('Audit PostgreSQL', err);
    console.error('Verifica la configurazione esistente in db/db.js, la rete e i permessi sui cataloghi.');
  } finally {
    if (client) {
      if (inTransaction) {
        try { await client.query('ROLLBACK'); console.log('PASS ROLLBACK eseguito'); }
        catch (err) { fail('ROLLBACK', err); }
      }
      client.release();
    }
    await pool.end();
  }
  console.log(`ESITO: ${state.pass} PASS, ${state.fail} FAIL, ${state.gap} GAP. Nessuna scrittura.`);
  if (state.fail) process.exitCode = 1;
}
