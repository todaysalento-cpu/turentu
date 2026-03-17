// test_correlate_roma_napoli.js
import ngeohash from 'ngeohash';
import { filterDisponibilita } from './engine/availability.engine.js';

// ===================== Setup richiesta =====================
const richiesta = {
  coord: { lat: 41.8967, lon: 12.4822 },     // Roma
  coordDest: { lat: 40.8518, lon: 14.2681 }, // Napoli
  start_datetime: "2026-03-03T16:30:00Z",
  posti_richiesti: 1,
};

// ===================== Setup cache =====================
const veicoliCache = {
  1: { id: 1, lat: 41.8967, lon: 12.4822, posti_totali: 4, geohash: ngeohash.encode(41.8967, 12.4822, 5) },
};

const disponibilitaCache = [
  {
    veicolo_id: 1,
    giorni_esclusi: [],
  },
];

const corseCache = [
  {
    id: 999,
    veicolo_id: 1,
    start_datetime: "2026-03-03T16:30:00Z",
    durata: 7200, // 2h
    geohashOrigine: ngeohash.encode(41.8967, 12.4822, 5),
    geohashDest: ngeohash.encode(40.8518, 14.2681, 5),
    posti_disponibili: 3,
    tipo_corsa: 'condivisa',
    stato: 'libero',
  },
];

// ===================== Test filtro =====================
const { slots, corse } = filterDisponibilita(richiesta, veicoliCache, disponibilitaCache, corseCache);

console.log('🏁 Slots compatibili:', slots.length, slots);
console.log('🏁 Corse compatibili:', corse.length, corse);