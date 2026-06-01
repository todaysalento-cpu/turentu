import pkg from 'pg';
import polyline from '@mapbox/polyline'; // Importa la libreria

const { Pool } = pkg;

const connectionString = process.env.DATABASE_URL || 'postgresql://corse_db_user:1kLjmIyqzXBAbpBuSfEE7F6uyKjLFMrL@dpg-d6uikbma2pns73fk5ppg-a.virginia-postgres.render.com:5432/corse_db';

export const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
  max: 75,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 30000,
});

export async function fetchCorse() {
  try {
    const res = await pool.query('SELECT * FROM corse WHERE percorso_polyline IS NOT NULL ORDER BY start_datetime DESC LIMIT 10');
    
    // Trasformiamo i dati grezzi aggiungendo decodedCoords
    return res.rows.map(corsa => {
      try {
        // Decodifica la stringa (il formato Google restituisce [lat, lon])
        const rawCoords = polyline.decode(corsa.percorso_polyline);
        
        // Turf.js richiede [lon, lat], quindi invertiamo l'ordine
        corsa.decodedCoords = rawCoords.map(p => [p[1], p[0]]);
      } catch (e) {
        console.error(`Errore decodifica corsa ${corsa.id}:`, e);
        corsa.decodedCoords = []; // Array vuoto se la polyline è corrotta
      }
      return corsa;
    });
  } catch (err) {
    console.error('Errore fetch corse:', err);
    return [];
  }
}