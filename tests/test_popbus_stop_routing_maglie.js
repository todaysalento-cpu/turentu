
import assert from 'node:assert/strict';
import { pool } from '../db/db.js';
import { leg } from '../services/popbus/v2/planner.js';

async function main() {
  console.log('=== POPBUS V2 - TEST ROUTING FERMATE MAGLIE ===');
  console.log('Modalità: nessuna scrittura DB, nessuna attivazione');

  const { rows } = await pool.query(`
    SELECT
      f.id,
      f.nome,
      f.attiva,
      f.verificata,
      ST_Y(f.posizione::geometry) AS lat,
      ST_X(f.posizione::geometry) AS lon
    FROM public.pixel_fermate f
    JOIN public.nodi_territoriali n
      ON n.id = f.nodo_territoriale_id
    WHERE f.id IN (14, 15)
      AND f.attiva = TRUE
      AND n.attivo = TRUE
      AND NOT EXISTS (
        SELECT 1
        FROM public.pixel_fermate_test_metadata t
        WHERE t.fermata_id = f.id
      )
      AND f.nome !~*
        '^[[:space:]]*(\\[TEST PIXEL\\]|TEST PIXEL([[:space:]]|$))'
      AND NOT EXISTS (
        SELECT 1
        FROM public.pixel_fermate_fonti ff
        WHERE ff.fermata_id = f.id
          AND ff.stato_verifica = 'non_ammessa'
      )
    ORDER BY f.id
  `);

  assert.equal(rows.length, 2, 'Fermate ammissibili 14 e 15 obbligatorie');

  const [a, b] = rows;

  const point = f => ({
    lat: Number(f.lat),
    lon: Number(f.lon)
  });

  const risultati = [];

  for (const [from, to] of [[a, b], [b, a]]) {
    console.log(`\nRouting ${from.id} -> ${to.id}`);

    const route = await leg(point(from), point(to));

    assert.ok(route.metres > 0, 'Distanza stradale positiva');
    assert.ok(route.seconds > 0, 'Durata stradale positiva');
    assert.ok(
      typeof route.polyline === 'string' && route.polyline.length > 0,
      'Geometria stradale presente'
    );

    risultati.push({
      da: Number(from.id),
      a: Number(to.id),
      distanza_stradale_m: Math.round(route.metres),
      durata_secondi: Math.round(route.seconds),
      durata_minuti: Number((route.seconds / 60).toFixed(2)),
      geometria_presente: true,
      coincidenza_stradale: route.roadCoincident
    });
  }

  console.table(risultati);

  console.log('\nPASS: routing stradale verificato in entrambe le direzioni.');
  console.log('ATTENZIONE: idoneità salita/discesa e tempi passeggeri ancora da validare.');
}

try {
  await main();
} catch (error) {
  console.error('FAIL:', error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
