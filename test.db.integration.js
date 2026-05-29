import { filterDisponibilita } from './services/search/engine/availability.engine.js';
import { pool } from './db/db.js';
import polyline from 'polyline';

async function testWithRealData() {
  console.log("🔍 Avvio Test di Integrazione con Diagnostica...");

  try {
    const { rows: veicoli } = await pool.query(`
      SELECT *, ST_Y(coord::geometry) as lat, ST_X(coord::geometry) as lon 
      FROM veicolo LIMIT 5
    `);
    
    const { rows: corse } = await pool.query(`
      SELECT *, 
             ST_Y(origine::geometry) AS origine_lat, ST_X(origine::geometry) AS origine_lon, 
             ST_Y(destinazione::geometry) AS dest_lat, ST_X(destinazione::geometry) AS dest_lon
      FROM corse 
      WHERE stato = $1 LIMIT 5
    `, ['prenotabile']);

    console.log(`✅ Connesso! Caricate ${corse.length} corse dal DB.`);

    // --- DIAGNOSTICA POLYLINE E GEOHASH ---
    corse.forEach(c => {
      console.log(`\n--- Analisi Corsa ${c.id} ---`);
      console.log(`Polyline presente: ${!!c.percorso_polyline}`);
      if (c.percorso_polyline) {
        try {
          const decoded = polyline.decode(c.percorso_polyline);
          console.log(`Decodifica OK. Punti trovati: ${decoded.length}`);
        } catch (e) {
          console.error(`ERRORE Decodifica Polyline: ${e.message}`);
        }
      }
      console.log(`Geohashes salvati: ${JSON.stringify(c.path_geohashes)}`);
    });

    const corseNormalizzate = corse.map(c => ({
        ...c,
        path_geohashes: c.path_geohashes || [],
        picco_occupazione: 0,
        posti_totali: c.posti_totali || 4
    }));
    
    const richiesta = {
      id: "TEST-REQ-001",
      start_datetime: new Date().toISOString(),
      posti_richiesti: 1,
      coord: { lat: 45.4642, lon: 9.1900 },
      coordDest: { lat: 45.4781, lon: 9.2270 }
    };

    const risultati = filterDisponibilita(richiesta, veicoli, [], corseNormalizzate);

    console.log("\n--- Risultati Analisi Finale ---");
    console.log(`Corse compatibili trovate: ${risultati.corse?.length || 0}`);
    
    if (risultati.corse?.length === 0) {
      console.log("ℹ️ Suggerimento: Se la polyline è valida, il problema è il Geohash. Prova a commentare il filtro Geohash nell'engine.");
    }

  } catch (err) {
    console.error("💥 Errore durante l'integrazione DB:", err);
  } finally {
    await pool.end();
  }
}

testWithRealData();