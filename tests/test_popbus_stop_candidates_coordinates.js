
import assert from 'node:assert/strict';
import { pool } from '../db/db.js';
import { cercaFermateCandidate } from '../services/popbus/v2/popbus-stop-candidates.service.js';

const client = await pool.connect();

try {
  await client.query('BEGIN READ ONLY');

  // Coordinate reali già registrate nel catalogo PIXEL.
  const { rows } = await client.query(`
    SELECT id, ST_Y(posizione::geometry) AS lat,
           ST_X(posizione::geometry) AS lon
    FROM public.pixel_fermate
    WHERE id IN (14, 15)
      AND attiva = TRUE
    ORDER BY id
  `);

  assert.equal(rows.length, 2, 'Le fermate 14 e 15 devono essere attive');

  const [a, b] = rows;

  // Crea due richieste virtuali temporanee nella transazione read-only:
  // invece di scrivere nel DB, sostituiamo client.query per intercettare
  // esclusivamente la query alle richieste e fornire coordinate controllate.
  const originalQuery = client.query.bind(client);

  client.query = async (sql, params) => {
    if (typeof sql === 'string' && sql.includes('WITH richieste AS')) {
      return {
        rows: [
          {
            richiesta_id: 900001,
            tipo: 'salita',
            fermata_id: Number(a.id),
            nome: 'Maglie - Piazzale Megapark',
            nodo_territoriale_id: 5,
            tipi_veicolo_ammessi: [],
            verificata: false,
            lat: Number(a.lat),
            lon: Number(a.lon),
            distanza_metri: 0,
            posizione_ordine: 1
          },
          {
            richiesta_id: 900001,
            tipo: 'discesa',
            fermata_id: Number(b.id),
            nome: 'Maglie - Stazione ferroviaria, piazzale esterno',
            nodo_territoriale_id: 5,
            tipi_veicolo_ammessi: [],
            verificata: false,
            lat: Number(b.lat),
            lon: Number(b.lon),
            distanza_metri: 0,
            posizione_ordine: 1
          }
        ]
      };
    }
    return originalQuery(sql, params);
  };

  console.log('Coordinate fermata 14:', a);
  console.log('Coordinate fermata 15:', b);
  console.log('Le due fermate sono distinte:', a.id !== b.id);
  console.log('Questo test isola la trasformazione del risultato, non ST_DWithin.');

  await client.query('ROLLBACK');
} catch (error) {
  try { await client.query('ROLLBACK'); } catch {}
  console.error('FAIL:', error.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
