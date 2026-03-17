// services/search/test_formatter_multi.js
import { formatResults } from './formatter/search.formatter.js';

// Simuliamo richiesta utente
const richiestaBase = {
  coord: { lat: 45.4642, lon: 9.191 },          // Milano
  coordDest: { lat: 44.4949, lon: 11.3426 },   // Bologna
  start_datetime: new Date("2026-03-04T08:00:00"),
  posti_richiesti: 1, // sarà sovrascritto nei test multiposti
};

// Corse filtrate dal DB (corsa 293)
const corseFiltrate = [
  {
    id: 293,
    veicolo_id: 10,
    origine_lat: 45.4642,
    origine_lon: 9.191,
    dest_lat: 44.4949,
    dest_lon: 11.3426,
    start_datetime: "2026-03-04T08:00:00",
    arrivo_datetime: "2026-03-04T14:00:00",
    durata: null,
    distanza: 467.8,
    stato: 'prenotabile',
    posti_prenotati: 1,
    primo_posto: 1,
    tipo_corsa: 'standard',
  }
];

// Cache veicoli
const veicoliCache = {
  10: { modello: "Mercedes Vito", servizi: ["WiFi", "Climatizzatore"], posti_totali: 8 }
};

(async () => {
  for (let postiRichiesti = 1; postiRichiesti <= 3; postiRichiesti++) {
    console.log(`\n--- Test formatter con posti richiesti = ${postiRichiesti} ---`);
    const richiesta = { ...richiestaBase, posti_richiesti: postiRichiesti };
    const risultati = await formatResults(richiesta, [], corseFiltrate, veicoliCache);
    risultati.forEach(r => {
      console.log(`Posti: ${postiRichiesti}, Prezzo calcolato: ${r.prezzo.toFixed(2)} €`);
    });
  }
})();