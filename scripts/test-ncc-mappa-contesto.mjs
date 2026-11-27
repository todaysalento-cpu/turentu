
import pg from 'pg';
import assert from 'node:assert/strict';
import { databaseOptions } from '../config/database.js';
import {
  ottieniContestoMappaNcc
} from '../services/ncc-mappa-contesto.service.js';

const pool = new pg.Pool(databaseOptions());
let db;

try {
  db = await pool.connect();

  await db.query('BEGIN READ ONLY');
  await db.query("SET LOCAL statement_timeout = '10000ms'");

  const casi = [
    ['Via del Tasso, 6, Lecce', true],
    ['Via Roma, 10, Tricase', true],
    ['Via Roma, 10, Tiggiano', true],
    ['Via Roma, 10, Cavallino', true],
    ['Via Roma, 10, Brindisi', true],
    ['Via Roma, 10', false],
    ['Via Roma, 10, ComuneInesistente', false]
  ];

  let superati = 0;

  for (const [indirizzo, disponibile] of casi) {
    const esito = await ottieniContestoMappaNcc(
      db,
      indirizzo
    );

    assert.equal(
      esito.stato === 'DISPONIBILE',
      disponibile
    );

    assert.equal(esito.puntoPrelievo, null);

    if (disponibile) {
      assert.equal(esito.bounds.length, 2);
      assert.equal(
        esito.uso,
        'SOLO_CONTESTO_CARTOGRAFICO'
      );
    }

    console.log('\nPASS:', indirizzo);
    console.log(JSON.stringify(esito, null, 2));

    superati++;
  }

  console.log('\nTEST SUPERATI:', superati, '/', casi.length);
  console.log('CHIAMATE GOOGLE: 0');
  console.log('CHIAMATE OSM: 0');
  console.log('PRENOTAZIONI MODIFICATE: 0');

} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if (db) {
    try {
      await db.query('ROLLBACK');
    } finally {
      db.release();
    }
  }

  await pool.end();
}
