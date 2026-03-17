import { loadCachesUltra, cercaSlotUltra } from './services/search/searchUltra.service.js';

async function testCache() {
  await loadCachesUltra();
  console.log('Cache caricata!');

  const risultati = await cercaSlotUltra({
    arrivo_datetime: '2026-01-28T12:30:00',
    coord: { lat: 41.891, lon: 12.495 },
    posti_richiesti: 2,
    km: 5,
  });

  console.log('Risultati cercaSlotUltra:');
  risultati.forEach(r => {
    console.log({
      veicolo_id: r.veicolo_id,
      slot_libero: r.slot_libero,
      distanzaKm: r.distanzaKm.toFixed(2),
      prezzo: r.prezzo.toFixed(2),
      corse: r.corseCompatibili.map(c => c.id),
      stato: r.stato
    });
  });
}

testCache();
