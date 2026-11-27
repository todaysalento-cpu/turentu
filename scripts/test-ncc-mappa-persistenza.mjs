
import pg from 'pg';
import assert from 'node:assert/strict';
import { databaseOptions } from '../config/database.js';

const pool = new pg.Pool({
  ...databaseOptions(),
  max: 1
});

let client;

try {
  client = await pool.connect();

  await client.query('BEGIN');
  await client.query("SET LOCAL statement_timeout = '10000ms'");
  await client.query("SET LOCAL lock_timeout = '2000ms'");

  await client.query(`
    CREATE TEMP TABLE test_ncc_mappa (
      LIKE public.ncc_prenotazioni_esterne
      INCLUDING CONSTRAINTS
    ) ON COMMIT DROP
  `);

  console.log('PASS: Tabella temporanea creata');

  await client.query(`
    INSERT INTO test_ncc_mappa (
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
      1,
      2,
      'TEST TEMPORANEO',
      'Via del Tasso, 6, Lecce',
      'Via Roma, 10, Lecce',
      now(),
      1,
      now(),
      now(),
      'DA_ELABORARE',
      'DA_ELABORARE'
    )
  `);

  for (const ruolo of ['origine', 'destinazione']) {

    const { rows } = await client.query(`
      UPDATE test_ncc_mappa
      SET
        ${ruolo}_lat = $1,
        ${ruolo}_lon = $2,
        ${ruolo}_place_id = NULL,
        ${ruolo}_stato_geo = 'VALIDATO_MANUALE',
        ${ruolo}_fonte_geo = 'OPERATORE_MAPPA',
        ${ruolo}_punto_operativo_id = NULL,
        ${ruolo}_verificata_il = now(),
        ${ruolo}_geo_scade_il =
          now() + interval '24 hours',
        ${ruolo}_dettaglio_geo = $3::jsonb
      WHERE id = 1
      RETURNING *
    `, [
      40.4584897,
      18.1829938,
      JSON.stringify({
        confermatoDaOperatore: true,
        operatoreId: '2',
        precisione: 'POSIZIONE_MANUALE',
        civicoVerificatoDaGoogle: false
      })
    ]);

    const r = rows[0];

    assert.equal(
      r[ruolo + '_stato_geo'],
      'VALIDATO_MANUALE'
    );

    assert.equal(
      r[ruolo + '_fonte_geo'],
      'OPERATORE_MAPPA'
    );

    assert.equal(r[ruolo + '_lat'], 40.4584897);
    assert.equal(r[ruolo + '_lon'], 18.1829938);
    assert.equal(r[ruolo + '_place_id'], null);
    assert.equal(r[ruolo + '_punto_operativo_id'], null);

    assert.equal(
      r[ruolo + '_dettaglio_geo']
        .confermatoDaOperatore,
      true
    );

    assert.ok(
      Date.parse(r[ruolo + '_geo_scade_il']) >
      Date.now()
    );

    console.log('PASS: Persistenza manuale', ruolo);
  }

  await client.query('SAVEPOINT coordinate_errate');

  await assert.rejects(
    () => client.query(`
      UPDATE test_ncc_mappa
      SET origine_lat = 999
      WHERE id = 1
    `),
    error => error.code === '23514'
  );

  await client.query(
    'ROLLBACK TO SAVEPOINT coordinate_errate'
  );

  console.log('PASS: Vincolo coordinate non valide');

  await client.query('ROLLBACK');

  const { rows } = await client.query(`
    SELECT to_regclass(
      'pg_temp.test_ncc_mappa'
    ) IS NULL AS eliminata
  `);

  assert.equal(rows[0].eliminata, true);

  console.log('PASS: Rollback e pulizia');
  console.log('TEST PERSISTENZA POSTGRESQL OK');
  console.log('PRENOTAZIONI REALI MODIFICATE: 0');
  console.log('CHIAMATE GOOGLE: 0');

} catch (error) {
  console.error('TEST FALLITO:', error.message);

  if (client) {
    await client.query('ROLLBACK').catch(() => {});
  }

  process.exitCode = 1;

} finally {
  if (client) client.release();
  await pool.end();
}
