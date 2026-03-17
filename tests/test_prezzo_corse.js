import { pool } from '../db/db.js';
import { calcolaPrezzo } from '../utils/pricing.util.js';

const POSTI_RICHIESTI_DEFAULT = 1;

async function testPrezzoCorse() {
  const res = await pool.query('SELECT * FROM corse ORDER BY id');
  
  for (const corsa of res.rows) {
    const postiRichiesti = POSTI_RICHIESTI_DEFAULT;

    const prezzo = await calcolaPrezzo(
      {
        km: Number(corsa.distanza),
        veicolo_id: corsa.veicolo_id,
        posti_prenotati: corsa.posti_prenotati,
        primo_posto: corsa.primo_posto
      },
      postiRichiesti,
      corsa.stato
    );

    console.log(`Corsa ${corsa.id} | Veicolo ${corsa.veicolo_id} | Stato ${corsa.stato}`);
    console.log(`Distanza: ${corsa.distanza} km | Prezzo: ${prezzo.toFixed(2)} €`);
    console.log(`Posti prenotati: ${corsa.posti_prenotati} | Posti richiesti: ${postiRichiesti} | Primo posto: ${corsa.primo_posto}`);
    console.log('------------------------------');
  }

  await pool.end();
}

testPrezzoCorse();
