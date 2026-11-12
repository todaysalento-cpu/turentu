import { Router } from 'express';
import { pool } from '../../db/db.js';
import { disconnectAccountSockets } from '../../socket.js';

const router = Router();

const credentials = [
  ['utente_push_tokens', 'user_id'],
  ['password_reset_codes', 'user_id'],
  ['verifiche_email_utente', 'utente_id'],
];

// Riferimenti applicativi verificati sullo schema, anche in assenza di FK.
const relations = [
  ['ar_gruppi', 'cliente_id'],
  ['autista_profilo', 'utente_id'],
  ['backup_pending_condivisi_20261017', 'cliente_id'],
  ['backup_prenotazioni_condivise_20261017', 'cliente_id'],
  ['chat_threads', 'cliente_id', 'driver_id'],
  ['flow_events', 'user_id'],
  ['notifications', 'user_id'],
  ['storico_contatti_ncc', 'admin_id'],
  ['veicolo', 'driver_id'],
];

const quote = identifier => '"' + identifier.replaceAll('"', '""') + '"';
const qualified = (schema, table) => quote(schema) + '.' + quote(table);
const parseId = value => /^\d+$/.test(String(value)) && Number(value) > 0 &&
  Number(value) <= 2147483647 ? Number(value) : null;

async function inspectDependencies(db, userId, lock) {
  const { rows: refs } = await db.query(`
    SELECT n.nspname AS schema, c.relname AS table,
      array_agg(a.attname::text ORDER BY k.pos) AS columns,
      array_agg(b.attname::text ORDER BY k.pos) AS target_columns
    FROM pg_constraint f
    JOIN pg_class c ON c.oid = f.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL unnest(f.conkey, f.confkey) WITH ORDINALITY AS k(src, dst, pos)
    JOIN pg_attribute a ON a.attrelid = f.conrelid AND a.attnum = k.src
    JOIN pg_attribute b ON b.attrelid = f.confrelid AND b.attnum = k.dst
    WHERE f.contype = 'f' AND f.confrelid = 'public.utente'::regclass
    GROUP BY f.oid, n.nspname, c.relname
  `);

  const { rows: legacy } = await db.query(`
    SELECT t.table_name, c.column_name, c.data_type
    FROM information_schema.tables t
    JOIN information_schema.columns c USING (table_schema, table_name)
    WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE' AND t.table_name = ANY($1)
  `, [relations.map(([table]) => table)]);
  const existing = new Set(legacy.map(row => row.table_name));
  const types = new Map(legacy.map(row => [row.table_name + '.' + row.column_name, row.data_type]));
  const locks = new Set();
  const checks = [];
  const values = [userId];

  for (const [table, ...columns] of relations) {
    if (!existing.has(table)) continue;
    const name = qualified('public', table);
    locks.add(name);
    const conditions = columns.map(column => {
      const type = types.get(table + '.' + column);
      if (['smallint', 'integer', 'bigint', 'numeric'].includes(type)) return quote(column) + ' = $1::integer';
      if (['text', 'character varying', 'character'].includes(type)) return quote(column) + ' = $1::integer::text';
      throw new Error('Riferimento utente da verificare: ' + table + '.' + column);
    });
    checks.push(`SELECT '${table}' AS relation WHERE EXISTS (
      SELECT 1 FROM ${name} WHERE ${conditions.join(' OR ')}
    )`);
  }

  for (const ref of refs) {
    const name = qualified(ref.schema, ref.table);
    const isCredential = ref.schema === 'public' && ref.columns.length === 1 &&
      ref.target_columns[0] === 'id' &&
      credentials.some(([table, column]) => table === ref.table && column === ref.columns[0]);
    if (isCredential) continue;
    const conditions = ref.columns.map((column, index) =>
      `r.${quote(column)} = u.${quote(ref.target_columns[index])}`).join(' AND ');
    checks.push(`SELECT $${values.push(ref.table)}::text AS relation WHERE EXISTS (
      SELECT 1 FROM ${name} r JOIN public.utente u ON ${conditions} WHERE u.id = $1
    )`);
  }

  if (lock) {
    credentials.forEach(([table]) => locks.add(qualified('public', table)));
    await db.query(`LOCK TABLE ${[...locks].sort().join(', ')} IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
  }
  if (!checks.length) return [];
  const { rows } = await db.query(checks.join(' UNION '), values);
  return rows.map(row => row.relation).sort();
}

async function verifyDeleteSchema(db) {
  // Blocca la procedura se una futura migrazione introduce effetti impliciti.
  const tables = ['public.utente', ...credentials.map(([table]) => 'public.' + table)];
  const { rows: [result] } = await db.query(`
    SELECT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE NOT tgisinternal AND tgenabled <> 'D' AND (tgtype & 8) <> 0
        AND tgrelid IN (SELECT name::regclass FROM unnest($1::text[]) AS name)
    ) OR EXISTS (
      SELECT 1 FROM pg_constraint WHERE contype = 'f'
        AND confrelid IN (SELECT name::regclass FROM unnest($2::text[]) AS name)
    ) AS unsafe
  `, [tables, tables.slice(1)]);
  if (result.unsafe) throw new Error('Lo schema di eliminazione richiede una nuova verifica');
}

async function loadTarget(db, id, lock = false) {
  const { rows: [target] } = await db.query(`
    SELECT id, lower(btrim(tipo)) AS role FROM public.utente
    WHERE id = $1 AND lower(btrim(tipo)) IN ('cliente', 'autista')
    ${lock ? 'FOR UPDATE' : ''}
  `, [id]);
  return target;
}

function handle(handler) {
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID utente non valido.' });
    if (id === Number(req.user.id)) return res.status(403).json({ error: 'Non puoi eliminare il tuo account da questa schermata.' });
    try {
      await handler(req, res, id);
    } catch (error) {
      console.error('Eliminazione utente admin:', error.code || error.message);
      if (['55P03', '23503', '40001', '40P01'].includes(error.code)) {
        return res.status(409).json({ error: 'Account o dati collegati in uso. Aggiorna la verifica e riprova.' });
      }
      res.status(500).json({ error: 'Impossibile completare la verifica o l’eliminazione.' });
    }
  };
}

router.get('/utenti/:id/eliminazione', handle(async (req, res, id) => {
  const admin = await pool.query(`
    SELECT id FROM public.utente WHERE id = $1 AND lower(btrim(tipo)) = 'admin'
  `, [req.user.id]);
  if (!admin.rowCount) return res.status(403).json({ error: 'Permesso amministrativo non valido.' });
  if (!await loadTarget(pool, id)) return res.status(404).json({ error: 'Utente eliminabile non trovato.' });
  const dependencies = await inspectDependencies(pool, id, false);
  res.json({ eliminabile: dependencies.length === 0, dipendenze: dependencies });
}));

router.delete('/utenti/:id', handle(async (req, res, id) => {
  const bearer = req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
  if (!bearer || (req.cookies?.token && req.cookies.token !== bearer)) {
    return res.status(403).json({ error: 'Per eliminare un account è richiesta l’autenticazione Bearer.' });
  }
  if (!req.is('application/json') || req.body?.conferma !== String(id)) {
    return res.status(400).json({ error: 'Inserisci l’ID esatto dell’utente per confermare.' });
  }

  const db = await pool.connect();
  let target;
  let dependencies;
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout = '2s'");
    await db.query("SET LOCAL statement_timeout = '8s'");
    await db.query('LOCK TABLE public.utente IN ROW EXCLUSIVE MODE');
    const admin = await db.query(`
      SELECT id FROM public.utente WHERE id = $1 AND lower(btrim(tipo)) = 'admin' FOR SHARE
    `, [req.user.id]);
    if (!admin.rowCount) {
      await db.query('ROLLBACK');
      return res.status(403).json({ error: 'Permesso amministrativo non valido.' });
    }

    target = await loadTarget(db, id, true);
    if (!target) {
      await db.query('ROLLBACK');
      return res.status(404).json({ error: 'Utente eliminabile non trovato.' });
    }
    dependencies = await inspectDependencies(db, id, true);
    if (!dependencies.length) {
      await verifyDeleteSchema(db);
      for (const [table, column] of credentials) {
        await db.query(`DELETE FROM ${qualified('public', table)} WHERE ${quote(column)} = $1`, [id]);
      }
      await db.query('DELETE FROM public.utente WHERE id = $1', [id]);
    }

    await db.query(`
      INSERT INTO public.admin_eliminazioni_utenti (admin_id, utente_id, esito, dipendenze)
      VALUES ($1, $2, $3, $4)
    `, [req.user.id, id, dependencies.length ? 'bloccato' : 'eliminato', dependencies]);
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }

  if (dependencies.length) {
    return res.status(409).json({ error: 'L’account ha dati collegati da conservare.', dipendenze: dependencies });
  }
  try {
    disconnectAccountSockets(target.id, target.role);
  } catch (error) {
    console.error('Disconnessione socket dopo eliminazione:', error.message);
  }
  res.json({ eliminato: true });
}));

export default router;
