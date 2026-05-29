import { filterDisponibilita } from './services/search/engine/availability.engine.js';
import { pool } from './db/db.js';

async function testVicinanzaPercorso() {
  console.log("🔍 Avvio Test: Vicinanza richiesta a percorso esistente...");

  try {
    // 1. Recuperiamo una corsa esistente (es. la 405 che sappiamo essere valida)
    const { rows: corse } = await pool.query(`
      SELECT *, 
             ST_Y(origine::geometry) AS origine_lat, ST_X(origine::geometry) AS origine_lon
      FROM corse WHERE id = 405
    `);

    if (corse.length === 0) {
      console.log("❌ Corsa di test non trovata!");
      return;
    }

    const corsa = {
      ...corse[0],
      path_geohashes: corse[0].path_geohashes || [],
      picco_occupazione: 0,
      posti_totali: 4
    };

    // 2. Definiamo una richiesta "vicina" (es. a 500 metri dal percorso)
    // Se la corsa 405 passa per 45.4642, 9.1900, noi cerchiamo a 45.4645, 9.1905
    const richiestaVicino = {
      id: "TEST-VICINO-001",
      start_datetime: new Date().toISOString(),
      posti_richiesti: 1,
      coord: { lat: 45.4645, lon: 9.1905 },      // Poco distante
      coordDest: { lat: 45.4785, lon: 9.2275 }    // Poco distante
    };

    console.log(`✅ Richiesta creata a breve distanza dal percorso della corsa ${corsa.id}`);

    // 3. Esecuzione
    const risultati = filterDisponibilita(richiestaVicino, [], [], [corsa]);

    // 4. Verifica
    if (risultati.corse.length > 0) {
      console.log("🎉 Successo: Il motore ha rilevato la corsa compatibile tramite deviazione!");
    } else {
      console.log("❌ Fallito: La richiesta è troppo lontana o il filtro è troppo rigido.");
    }

  } catch (err) {
    console.error("💥 Errore:", err);
  } finally {
    await pool.end();
  }
}

testVicinanzaPercorso();