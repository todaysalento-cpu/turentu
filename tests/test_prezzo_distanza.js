// tests/test_prezzo_corse.js
import { pool } from '../db/db.js';
import { calcolaPrezzo } from '../utils/pricing.util.js';

async function testPrezzoCorse() {
  try {
    const res = await pool.query(`
      SELECT id, veicolo_id, stato, distanza, posti_prenotati, primo_posto, origine, destinazione
      FROM corse
    `);

    for (const c of res.rows) {
      // Estrai lat/lon da PostGIS geometry
      const lonOrig = c.origine ? c.origine.x : null;
      const latOrig = c.origine ? c.origine.y : null;
      const lonDest = c.destinazione ? c.destinazione.x : null;
      const latDest = c.destinazione ? c.destinazione.y : null;

      // Prepara slot
      const slot = {
        km: Number(c.distanza ?? 0),
        veicolo_id: c.veicolo_id,
        posti_prenotati: c.posti_prenotati ?? 0,
        primo_posto: c.primo_posto ?? 0,
        tipo_corsa: 'standard'
      };

      const prezzo = await calcolaPrezzo(slot, 1, c.stato);

      console.log(`Corsa ${c.id} | Veicolo ${c.veicolo_id} | Stato ${c.stato}`);
      console.log(`Origine: ${latOrig}, ${lonOrig} → Destinazione: ${latDest}, ${lonDest}`);
      console.log(`Distanza: ${c.distanza} km | Prezzo: ${prezzo.toFixed(2)} €`);
      console.log('------------------------------');
    }
  } catch (err) {
    console.error(err);
  } finally {
    await pool.end();
  }
}

testPrezzoCorse();
