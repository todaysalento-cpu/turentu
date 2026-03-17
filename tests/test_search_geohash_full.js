// tests/test_search_geohash_dynamic.js
import { pool } from '../db/db.js';
import { loadCachesUltra, cercaSlotUltra } from '../services/search/searchUltra.service.js';

async function clearDb() {
  const client = await pool.connect();
  try {
    await client.query('DELETE FROM corse');
    await client.query('DELETE FROM disponibilita_veicolo');
    await client.query('DELETE FROM veicolo');
  } finally {
    client.release();
  }
}

async function populateTestData() {
  const client = await pool.connect();
  try {
    // Veicoli
    await client.query(`
      INSERT INTO veicolo (id, modello, posti_totali, euro_km, coord)
      VALUES
        (1, 'Auto1', 4, 0.50, ST_GeomFromText('POINT(12.495 41.891)', 4326)),
        (2, 'Auto2', 4, 0.50, ST_GeomFromText('POINT(12.496 41.892)', 4326)),
        (3, 'Auto3', 4, 0.55, ST_GeomFromText('POINT(12.497 41.893)', 4326))
    `);

    // Disponibilità veicoli
    await client.query(`
      INSERT INTO disponibilita_veicolo (veicolo_id, start, fine, giorni_esclusi, inattivita)
      VALUES
        (1, '2026-01-28T09:00', '2026-01-28T18:00', '{}', '[{"start":"2026-01-28T12:00","fine":"2026-01-28T13:00"}]'),
        (2, '2026-01-28T09:00', '2026-01-28T18:00', '{}', '[]'),
        (3, '2026-01-28T09:00', '2026-01-28T18:00', '{}', '[]')
    `);

    // Corse
    await client.query(`
      INSERT INTO corse (id, veicolo_id, start_datetime, tipo_corsa, origine, destinazione, stato, posti_disponibili)
      VALUES
        (1, 1, '2026-01-28T10:00', 'condivisa', ST_GeomFromText('POINT(12.495 41.891)',4326), ST_GeomFromText('POINT(12.500 41.895)',4326), 'prenotabile', 3),
        (2, 2, '2026-01-28T11:00', 'condivisa', ST_GeomFromText('POINT(12.496 41.892)',4326), ST_GeomFromText('POINT(12.501 41.896)',4326), 'prenotabile', 2)
    `);
  } finally {
    client.release();
  }
}

async function testSearchUltra() {
  try {
    console.log('🚀 Pulizia DB...');
    await clearDb();

    console.log('🚀 Popolamento dati di test...');
    await populateTestData();
    console.log('✅ Dati di test popolati correttamente');

    console.log('📦 Caricamento cache veicoli e corse...');
    await loadCachesUltra();
    console.log('✅ Cache caricata');

    const richiesta = {
      arrivo_datetime: '2026-01-28T10:30',
      coord: { lat: 41.891, lon: 12.495 },
      posti_richiesti: 1,
      km: 5
    };

    console.log('🔍 Esecuzione ricerca ultra...');
    const results = await cercaSlotUltra(richiesta);

    results.forEach((r, i) => {
      console.log(`--- Risultato ${i + 1} ---`);
      console.log(`Veicolo: ${r.veicolo_id}`);
      console.log(`Stato: ${r.stato}`);
      console.log(`Slot libero: ${r.slot_libero}`);
      console.log(`Distanza: ${r.distanzaKm.toFixed(2)} km`);
      console.log(`Prezzo stimato: €${r.prezzo.toFixed(2)}`);
      if (r.corseCompatibili.length) console.log(`Corse compatibili: ${r.corseCompatibili.length}`);
      console.log(`Coordinate veicolo: lat ${r.coord.lat}, lon ${r.coord.lon}`);
    });

    console.log('✅ Test completato');

  } catch (err) {
    console.error('❌ Errore nel test searchUltra:', err);
  } finally {
    await pool.end();
  }
}

testSearchUltra();
