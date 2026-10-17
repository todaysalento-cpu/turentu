import { pool } from '../db/db.js';
import polyline from '@mapbox/polyline';

async function verificaPolyline() {
  try {
    const { rows } = await pool.query(`
      SELECT
        id,
        origine_address,
        destinazione_address,
        percorso_polyline,
        distanza,
        km_riposizionamento,
        start_datetime,
        arrivo_datetime
      FROM public.corse
      WHERE id IN (866, 899)
      ORDER BY id
    `);

    for (const corsa of rows) {
      console.log('\n======================================');
      console.log(`🚗 CORSA ${corsa.id}`);
      console.log('======================================');

      if (!corsa.percorso_polyline) {
        console.log('❌ Polyline assente');
        continue;
      }

      const punti = polyline.decode(corsa.percorso_polyline);

      const primo = punti[0];
      const ultimo = punti[punti.length - 1];
      const centrale = punti[Math.floor(punti.length / 2)];

      console.log('Origine:', corsa.origine_address);
      console.log('Destinazione:', corsa.destinazione_address);
      console.log('Numero punti:', punti.length);

      console.log('📍 Primo punto:', primo);
      console.log('📍 Punto centrale:', centrale);
      console.log('📍 Ultimo punto:', ultimo);

      console.log('Distanza corsa:', corsa.distanza, 'km');
      console.log('Km riposizionamento:', corsa.km_riposizionamento);

      const durataMinuti =
        (new Date(corsa.arrivo_datetime) -
          new Date(corsa.start_datetime)) / 60000;

      console.log('Durata registrata:', durataMinuti, 'minuti');

      if (punti.length < 2) {
        console.log('❌ Polyline non valida');
      } else {
        console.log('✅ Polyline decodificata correttamente');
      }
    }
  } catch (error) {
    console.error('❌ ERRORE:', error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

verificaPolyline();