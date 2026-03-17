import { loadCachesUltra, cercaSlotUltra } from '../services/search/searchUltra.service.js';
import { pool } from '../db/db.js';

async function stressTest() {
  console.log('📦 Caricamento cache veicoli e corse...');
  await loadCachesUltra();

  const NUM_TEST = 1000; // quante richieste simulare
  const richieste = [];

  // genera richieste random vicine a Roma (lat ~41.89, lon ~12.49)
  for (let i = 0; i < NUM_TEST; i++) {
    richieste.push({
      arrivo_datetime: new Date(Date.now() + Math.random() * 3600_000).toISOString(), // entro 1h
      coord: {
        lat: 41.891 + Math.random() * 0.01, 
        lon: 12.495 + Math.random() * 0.01
      },
      km: 5 + Math.random() * 20,  // km richiesti
      posti_richiesti: 1 + Math.floor(Math.random() * 3)
    });
  }

  console.time('StressTest');
  for (let i = 0; i < NUM_TEST; i++) {
    await cercaSlotUltra(richieste[i]);
  }
  console.timeEnd('StressTest');

  console.log('✅ Stress test completato');
  await pool.end();
}

stressTest().catch(err => console.error(err));
