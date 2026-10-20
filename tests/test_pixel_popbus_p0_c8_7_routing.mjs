// TURENTU P0-C8.7 - Routing reale 8 -> 5 -> 7 -> 8.
// Copiare come tests/test_pixel_popbus_p0_c8_7_routing.mjs
// Eseguire: set TURENTU_ALLOW_GOOGLE_ROUTING_TEST=1
//           node --env-file=.env tests\test_pixel_popbus_p0_c8_7_routing.mjs
// SOLA LETTURA DB. Tre chiamate Google Maps, possibili costi API.
// Nessuna scrittura, nessuna chiamata Stripe, nessuna attivazione.
import assert from 'node:assert/strict';
import { pool } from '../db/db.js';
import { leg } from '../services/popbus/v2/planner.js';

const NODE_8 = Object.freeze({ id: 8, lat: 39.9302065, lon: 18.3584374 });
const NODE_5 = Object.freeze({ id: 5, lat: 40.117872, lon: 18.298862 });
const GAP_SECONDS = 45 * 60;
const TOLERANCE_SECONDS = 30 * 60; // diagnostica teorica, non autorizza slittamenti

function quoteIdent(s) { return '"' + s.replaceAll('"', '""') + '"'; }
async function loadNode7() {
  const tables = await pool.query(`
    SELECT table_schema, table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name IN ('nodi_territoriali','nodi_territoriale','nodi')
    ORDER BY CASE table_name WHEN 'nodi_territoriali' THEN 0 WHEN 'nodi_territoriale' THEN 1 ELSE 2 END
  `);
  for (const t of tables.rows) {
    const colsResult = await pool.query(`
      SELECT column_name, data_type, udt_name FROM information_schema.columns
      WHERE table_schema=$1 AND table_name=$2
    `, [t.table_schema, t.table_name]);
    const cols = new Map(colsResult.rows.map(c => [c.column_name, c]));
    if (!cols.has('id')) continue;
    const table = `${quoteIdent(t.table_schema)}.${quoteIdent(t.table_name)}`;
    let sql;
    const lat = ['lat','latitude','latitudine'].find(x => cols.has(x));
    const lon = ['lon','lng','longitude','longitudine'].find(x => cols.has(x));
    if (lat && lon) {
      sql = `SELECT ${quoteIdent(lat)}::float8 AS lat, ${quoteIdent(lon)}::float8 AS lon FROM ${table} WHERE id=$1`;
    } else {
      const geom = ['coord','geom','geometry','geometria','coordinate','posizione'].find(x =>
        ['geometry','geography'].includes(cols.get(x)?.udt_name));
      if (!geom) continue;
      sql = `SELECT ST_Y(${quoteIdent(geom)}::geometry)::float8 AS lat, ST_X(${quoteIdent(geom)}::geometry)::float8 AS lon FROM ${table} WHERE id=$1`;
    }
    const { rows } = await pool.query(sql, [7]);
    if (rows.length && Number.isFinite(rows[0].lat) && Number.isFinite(rows[0].lon)) {
      return Object.freeze({ id: 7, lat: rows[0].lat, lon: rows[0].lon });
    }
  }
  throw new Error('Coordinate nodo 7 non individuate automaticamente. Verificare tabella nodi e colonne geografiche.');
}

async function main() {
  if (process.env.TURENTU_ALLOW_GOOGLE_ROUTING_TEST !== '1') {
    throw new Error('Google routing NON autorizzato: impostare TURENTU_ALLOW_GOOGLE_ROUTING_TEST=1');
  }
  const n7 = await loadNode7();
  console.log('=== P0-C8.7 / NODI ===');
  console.table([NODE_8, NODE_5, n7]);
  const pairs = [[NODE_8, NODE_5], [NODE_5, n7], [n7, NODE_8]];
  const segments = [];
  for (const [from, to] of pairs) {
    const r = await leg(from, to);
    assert(Number.isFinite(r.metres) && r.metres > 0, `Distanza ${from.id}->${to.id} non valida`);
    assert(Number.isFinite(r.seconds) && r.seconds > 0, `Durata ${from.id}->${to.id} non valida`);
    assert(typeof r.polyline === 'string' && r.polyline.length > 0, `Polyline ${from.id}->${to.id} assente`);
    segments.push({ tratta: `${from.id}->${to.id}`, km: +(r.metres / 1000).toFixed(3), secondi: r.seconds,
      minuti: +(r.seconds / 60).toFixed(2), roadCoincident: r.roadCoincident });
  }
  console.log('=== ROUTING REALE GOOGLE / PLANNER V2 ===');
  console.table(segments);
  const commerciale = segments[0].secondi + segments[1].secondi;
  const riposizionamento = segments[2].secondi;
  const totale = commerciale + riposizionamento;
  const nominalGap = GAP_SECONDS - totale;
  console.log('=== VALUTAZIONE NOMINALE (senza soste, avvicinamento o ritorno base) ===');
  console.log(JSON.stringify({
    tempoCommercialeMin: +(commerciale / 60).toFixed(2),
    tempoRiposizionamentoMin: +(riposizionamento / 60).toFixed(2),
    tempoCicloMin: +(totale / 60).toFixed(2),
    intervalloPartenzeMin: 45,
    margineNominaleMin: +(nominalGap / 60).toFixed(2),
    ripetizioneOgni45MinNominalmenteFattibile: nominalGap >= 0,
    gapConSlittamentoMassimoTeoricoMin: +( (GAP_SECONDS + 2*TOLERANCE_SECONDS - totale)/60).toFixed(2)
  }, null, 2));
  if (nominalGap < 0) console.log('NO: stessa vettura non ripete il giro ogni 45 minuti agli orari nominali.');
  else console.log('SI SOLO NOMINALE: servono preflight temporale ai nodi, soste, turno ed economia.');
  console.log('Nessuna scrittura DB, nessun pagamento, nessuna attivazione.');
}
try { await main(); }
catch (err) { console.error('FAIL P0-C8.7:', err?.stack || err); process.exitCode = 1; }
finally { await pool.end(); }
