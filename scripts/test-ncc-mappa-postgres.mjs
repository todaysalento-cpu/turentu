
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

  await client.query('BEGIN READ ONLY');
  await client.query("SET LOCAL statement_timeout = '10000ms'");

  console.log('CONNESSIONE POSTGRESQL OK');

  const { rows: colonne } = await client.query(`
    SELECT
      column_name,
      data_type,
      character_maximum_length,
      is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'ncc_prenotazioni_esterne'
    ORDER BY column_name
  `);

  const campi = [
    'lat',
    'lon',
    'place_id',
    'normalizzata',
    'stato_geo',
    'fonte_geo',
    'dettaglio_geo',
    'verificata_il',
    'geo_scade_il',
    'punto_operativo_id'
  ];

  for (const ruolo of ['origine', 'destinazione']) {
    for (const campo of campi) {
      const nome = ruolo + '_' + campo;

      const colonna = colonne.find(
        c => c.column_name === nome
      );

      assert.ok(colonna, 'Colonna mancante: ' + nome);

      if (campo === 'fonte_geo') {
        assert.ok(
          colonna.data_type === 'text' ||
          colonna.character_maximum_length >=
            'OPERATORE_MAPPA'.length
        );
      }

      if (campo === 'place_id' ||
          campo === 'punto_operativo_id') {
        assert.equal(colonna.is_nullable, 'YES');
      }

      if (campo === 'dettaglio_geo') {
        assert.equal(colonna.data_type, 'jsonb');
      }

      if (campo === 'lat' || campo === 'lon') {
        assert.equal(colonna.data_type, 'double precision');
      }

      console.log('PASS:', nome, colonna.data_type);
    }
  }

  const { rows: vincoli } = await client.query(`
    SELECT
      conname,
      pg_get_constraintdef(oid) AS definizione
    FROM pg_constraint
    WHERE conrelid =
      'public.ncc_prenotazioni_esterne'::regclass
    ORDER BY conname
  `);

  console.log('\nVINCOLI DATABASE');
  console.table(vincoli);

  const { rows: triggers } = await client.query(`
    SELECT
      tgname,
      tgenabled,
      pg_get_triggerdef(oid) AS definizione
    FROM pg_trigger
    WHERE tgrelid =
      'public.ncc_prenotazioni_esterne'::regclass
      AND NOT tgisinternal
    ORDER BY tgname
  `);

  console.log('\nTRIGGER DATABASE');
  console.table(triggers);

  const { rows: territorio } = await client.query(`
    SELECT COUNT(*)::integer AS comuni
    FROM public.pixel_confini_comunali
    WHERE ST_Covers(
      geom,
      ST_SetSRID(
        ST_MakePoint(18.1829938, 40.4584897),
        4326
      )
    )
  `);

  console.log('\nVERIFICA COPERTURA TERRITORIALE');
  console.table(territorio);

  await client.query('ROLLBACK');

  console.log('\nVERIFICA SCHEMA COMPLETATA');
  console.log('MODIFICHE PRENOTAZIONI: 0');
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
