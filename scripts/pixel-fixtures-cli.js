// scripts/pixel-fixtures-cli.js — fixture sintetiche, NON fermate operative.
import { pool } from '../db/db.js';

const [command, ...args] = process.argv.slice(2);
const ids = args.map(Number);
const valid = ids.length === 2 && ids.every(n => Number.isSafeInteger(n) && n > 0) && ids[0] !== ids[1];
const enabled = process.env.PIXEL_TEST_MODE === 'true' &&
  String(process.env.STRIPE_SECRET_KEY || '').startsWith('sk_test_') &&
  process.env.PIXEL_FIXTURES_ACK === 'SYNTHETIC_DB_WRITES';

if (!['preview', 'create', 'cleanup'].includes(command) || !valid) {
  console.error('Uso: node scripts/pixel-fixtures-cli.js preview|create|cleanup <nodoOrigine> <nodoDestinazione>');
  process.exit(2);
}
if (!enabled) {
  console.error('Richiesti PIXEL_TEST_MODE=true, STRIPE_SECRET_KEY=sk_test_... e PIXEL_FIXTURES_ACK=SYNTHETIC_DB_WRITES');
  process.exit(2);
}

const schema = `CREATE TABLE IF NOT EXISTS public.pixel_fixture_stops (
  fermata_id bigint PRIMARY KEY REFERENCES public.pixel_fermate(id) ON DELETE CASCADE,
  nodo_territoriale_id bigint NOT NULL,
  fixture_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
)`;

const c = await pool.connect();
try {
  await c.query('BEGIN');
  // Evita due esecuzioni concorrenti del medesimo CLI.
  await c.query('SELECT pg_advisory_xact_lock(67322026, 1)');
  if (command !== 'preview') await c.query(schema);
  const nodes = [];
  for (const id of ids) {
    const { rows } = await c.query(`
      SELECT n.id, n.nome, n.codice_istat_comune,
        ST_Y(n.posizione::geometry)::float8 AS lat,
        ST_X(n.posizione::geometry)::float8 AS lon
      FROM public.nodi_territoriali n WHERE n.id=$1 AND n.attivo=true`, [id]);
    if (!rows.length || !rows[0].codice_istat_comune) throw new Error(`Nodo ${id} assente/inattivo o senza ISTAT`);
    nodes.push(rows[0]);
  }
  const output = [];
  for (const n of nodes) {
    const key = `PIXEL_E2E_SYNTH_NODE_${n.id}`;
    const name = `[TEST PIXEL] Nodo ${n.id} - fermata sintetica`;
    // Coordinate DERIVATE DAL NODO TURENTU, non da Google/OSM.
    // Non rappresentano un punto di salita fisicamente autorizzato.
    const lon = Number(n.lon), lat = Number(n.lat);
    if (![lat, lon].every(Number.isFinite)) throw new Error(`Coordinate nodo ${n.id} non valide`);
    const existing = command === 'preview' ? { rows: [] } : await c.query(`
      SELECT f.id FROM public.pixel_fixture_stops x
      JOIN public.pixel_fermate f ON f.id=x.fermata_id
      WHERE x.fixture_key=$1 AND f.nodo_territoriale_id=$2`, [key, n.id]);
    if (existing.rows.length) {
      output.push({ nodo: n.id, stato: 'gia_esistente', fermata_id: existing.rows[0].id });
      continue;
    }
    if (command === 'cleanup') {
      output.push({ nodo: n.id, stato: 'nessuna_fixture' });
      continue;
    }
    const budget = await c.query(`
      SELECT COALESCE(max_fermate_override,max_fermate_auto)::int AS limite
      FROM public.pixel_budget_comunali WHERE codice_istat_comune=$1
      ${command === 'create' ? 'FOR UPDATE' : ''}`, [n.codice_istat_comune]);
    if (!budget.rows.length || budget.rows[0].limite == null) throw new Error(`Budget assente per ${n.codice_istat_comune}`);
    const count = await c.query(`
      SELECT COUNT(*)::int AS totale FROM public.pixel_fermate f
      JOIN public.nodi_territoriali n ON n.id=f.nodo_territoriale_id
      WHERE n.codice_istat_comune=$1`, [n.codice_istat_comune]);
    if (count.rows[0].totale >= budget.rows[0].limite) {
      output.push({ nodo: n.id, stato: 'budget_esaurito' });
      continue;
    }
    const dup = await c.query(`
      SELECT f.id FROM public.pixel_fermate f
      JOIN public.nodi_territoriali n ON n.id=f.nodo_territoriale_id
      WHERE n.codice_istat_comune=$1
        AND ST_DWithin(f.posizione, ST_SetSRID(ST_MakePoint($2,$3),4326)::geography,30)
      LIMIT 1`, [n.codice_istat_comune, lon, lat]);
    if (dup.rows.length) {
      output.push({ nodo: n.id, stato: 'punto_occupato_30m', fermata_id: dup.rows[0].id });
      continue;
    }
    if (command === 'preview') {
      output.push({ nodo: n.id, stato: 'inseribile', lat, lon, nome: name });
      continue;
    }
    const inserted = await c.query(`
      INSERT INTO public.pixel_fermate
        (nodo_territoriale_id,nome,indirizzo,posizione,tipi_veicolo_ammessi,verificata,attiva)
      VALUES ($1,$2,NULL,ST_SetSRID(ST_MakePoint($3,$4),4326)::geography,
        ARRAY[]::text[],FALSE,FALSE) RETURNING id`, [n.id, name, lon, lat]);
    await c.query(`INSERT INTO public.pixel_fixture_stops (fermata_id,nodo_territoriale_id,fixture_key)
      VALUES ($1,$2,$3)`, [inserted.rows[0].id, n.id, key]);
    output.push({ nodo: n.id, stato: 'creata', fermata_id: inserted.rows[0].id });
  }
  if (command === 'cleanup') {
    const removed = await c.query(`
      DELETE FROM public.pixel_fermate f USING public.pixel_fixture_stops x
      WHERE f.id=x.fermata_id AND x.fixture_key = ANY($1::text[])
        AND f.attiva=false AND f.verificata=false
      RETURNING f.id`, [ids.map(id => `PIXEL_E2E_SYNTH_NODE_${id}`)]);
    output.push({ stato: 'rimosse', ids: removed.rows.map(r => r.id) });
  }
  if (command === 'preview') await c.query('ROLLBACK');
  else await c.query('COMMIT');
  console.log(JSON.stringify({ command, output }, null, 2));
} catch (e) {
  await c.query('ROLLBACK');
  console.error('Fixture PIXEL:', e.message);
  process.exitCode = 1;
} finally {
  c.release();
  await pool.end();
}
