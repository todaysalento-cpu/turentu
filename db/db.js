// db.js
import pkg from 'pg';
const { Pool } = pkg;

// Usa la variabile d'ambiente DATABASE_URL se disponibile, altrimenti fallback su localhost
const connectionString = process.env.DATABASE_URL || 'postgresql://corse_db_user:1kLjmIyqzXBAbpBuSfEE7F6uyKjLFMrL@dpg-d6uikbma2pns73fk5ppg-a.virginia-postgres.render.com:5432/corse_db';

export const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false }, // necessario per Render
  max: 75,
  idleTimeoutMillis: 5000,
  connectionTimeoutMillis: 5000,
});

// Funzione di esempio per fetch delle corse
export async function fetchCorse() {
  try {
    const res = await pool.query('SELECT * FROM corse ORDER BY start_datetime DESC LIMIT 10');
    return res.rows;
  } catch (err) {
    console.error('Errore fetch corse:', err);
    return [];
  }
}