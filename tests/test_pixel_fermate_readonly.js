// Destinazione: tests/test_pixel_fermate_readonly.js
// Test di regressione PIXEL: SOLO LETTURA, nessuna Google API, nessuna scrittura.
import assert from 'node:assert/strict';
import { pool } from '../db/db.js';

const client = await pool.connect();
let checks = 0;
function ok(condition, description) {
  assert.ok(condition, description);
  console.log(`OK ${++checks}: ${description}`);
}
try {
  await client.query('BEGIN READ ONLY');
  const { rows: functions } = await client.query(`
    SELECT p.proname, pg_get_functiondef(p.oid) AS definition
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname='public' AND p.proname IN
      ('pixel_fermate_candidate','pixel_fermate_per_nodo','pixel_valida_coppia_fermate')
  `);
  ok(functions.length === 3, 'Le tre funzioni PIXEL esistono');
  for (const f of functions) {
    ok(f.definition.includes('pixel_fermate_test_metadata'), `${f.proname}: esclusione metadata test presente`);
    ok(f.definition.includes('non_ammessa'), `${f.proname}: esclusione evidenze negative presente`);
  }
  const { rows: stops } = await client.query(`
    SELECT f.id, f.nome, f.attiva, f.verificata, f.nodo_territoriale_id,
           n.attivo AS nodo_attivo,
           EXISTS(SELECT 1 FROM public.pixel_fermate_test_metadata t WHERE t.fermata_id=f.id) AS test_metadata,
           EXISTS(SELECT 1 FROM public.pixel_fermate_fonti ff WHERE ff.fermata_id=f.id AND ff.stato_verifica='non_ammessa') AS negative
    FROM public.pixel_fermate f JOIN public.nodi_territoriali n ON n.id=f.nodo_territoriale_id
    ORDER BY f.id
  `);
  for (const stop of stops) {
    const synthetic = /^\s*(?:\[TEST PIXEL\]|TEST PIXEL\b)/i.test(stop.nome);
    if (!synthetic) continue;
    const { rows: catalog } = await client.query(
      'SELECT fermata_id FROM public.pixel_fermate_per_nodo($1::bigint) WHERE fermata_id=$2::bigint',
      [stop.nodo_territoriale_id, stop.id]
    );
    ok(catalog.length === 0, `Fermata sintetica ${stop.id} esclusa dal catalogo`);
  }
  const ids = stops.filter(s => /^\s*(?:\[TEST PIXEL\]|TEST PIXEL\b)/i.test(s.nome)).map(s => s.id);
  if (ids.length >= 2) {
    const { rows } = await client.query('SELECT * FROM public.pixel_valida_coppia_fermate($1::bigint,$2::bigint)', ids.slice(0,2));
    ok(rows.length === 1 && rows[0].valida === false, 'Coppia sintetica non valida');
  }
  // Controllo logico puro: NON crea una fermata nel DB.
  function eligible(s) {
    return s.attiva === true && s.nodo_attivo === true && !s.test_metadata &&
      !/^\s*(?:\[TEST PIXEL\]|TEST PIXEL\b)/i.test(s.nome) && !s.negative;
  }
  const base = { attiva: true, nodo_attivo: true, test_metadata: false, nome: 'Fermata ordinaria', negative: false, verificata: false, tipi_veicolo_ammessi: [] };
  ok(eligible(base), 'Scenario simulato: attiva, non certificata, senza tipi => operativa');
  ok(!eligible({...base, nodo_attivo:false}), 'Scenario simulato: nodo inattivo => esclusa');
  ok(!eligible({...base, negative:true}), 'Scenario simulato: evidenza negativa => esclusa');
  ok(!eligible({...base, test_metadata:true}), 'Scenario simulato: fixture metadata => esclusa');
  ok(!eligible({...base, nome:'[TEST PIXEL] prova'}), 'Scenario simulato: nome test => esclusa');
  await client.query('ROLLBACK');
  console.log(`\nPASS: ${checks} verifiche. Nessuna scrittura. Scenari simulati NON sono test di attivazione reale.`);
} catch (err) {
  try { await client.query('ROLLBACK'); } catch {}
  console.error('FAIL:', err.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
