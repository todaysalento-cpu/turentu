import 'dotenv/config';
import { pool } from '../db/db.js';
import { getLocalitaSafe } from '../utils/maps.util.js';

async function corsiConLocalita() {
  const res = await pool.query(`
    SELECT id,
           veicolo_id,
           stato,
           distanza,
           posti_prenotati,
           primo_posto,
           start_datetime,
           ST_Y(origine::geometry) AS lat_origine,
           ST_X(origine::geometry) AS lon_origine,
           ST_Y(destinazione::geometry) AS lat_destinazione,
           ST_X(destinazione::geometry) AS lon_destinazione
    FROM corse
    ORDER BY id
  `);

  const corsi = await Promise.all(res.rows.map(async c => ({
    id: c.id,
    veicolo_id: c.veicolo_id,
    stato: c.stato,
    distanza: c.distanza,
    posti_prenotati: c.posti_prenotati,
    primo_posto: c.primo_posto,
    start_datetime: c.start_datetime,
    coordOrigine: { lat: c.lat_origine, lon: c.lon_origine },
    coordDestinazione: { lat: c.lat_destinazione, lon: c.lon_destinazione },
    localitaOrigine: await getLocalitaSafe({ lat: c.lat_origine, lon: c.lon_origine }),
    localitaDestinazione: await getLocalitaSafe({ lat: c.lat_destinazione, lon: c.lon_destinazione })
  })));

  console.log(corsi);
  return corsi;
}

corsiConLocalita();
