import pkg from 'pg';
import polyline from '@mapbox/polyline'; // Importa la libreria

const { Pool } = pkg;

import { databaseOptions } from '../config/database.js';

export const pool = new Pool(databaseOptions());

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