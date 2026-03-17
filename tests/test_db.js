// tests/test_db.js
import { pool } from '../db/db.js'; // percorso corretto al tuo db.js

async function testDB() {
  try {
    const res = await pool.query('SELECT current_database(), current_schema();');
    console.log(res.rows);

    const corsaTest = await pool.query('SELECT * FROM corse WHERE id = $1', [249]);
    console.log('Corsa test:', corsaTest.rows);
  } catch (err) {
    console.error(err);
  } finally {
    await pool.end(); // chiude il pool dopo il test
  }
}

testDB();