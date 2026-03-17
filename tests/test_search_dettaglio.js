import 'dotenv/config';
import { loadCachesUltra, cercaSlotUltra } from '../services/search/searchUltra.service.js';

async function testCorsaPrezzoUltra() {
  // Carica cache da DB
  await loadCachesUltra();

  // Richiesta esempio
  const richiesta = {
    coord: { lat: 41.8933203, lon: 12.4829321 },     // Origine
    coordDest: { lat: 45.4641943, lon: 9.1896346 },  // Destinazione
    posti_richiesti: 1,
    arrivo_datetime: '2026-01-30T12:00:00Z'
  };

  // Cerca slot e corse
  const results = await cercaSlotUltra(richiesta);

  console.log('=== Risultati Slot & Corse ===\n');

  results.forEach((r, i) => {
    console.log(`Risultato ${i + 1}`);
    console.log(`Tipo: ${r.tipo}`);
    console.log(`Veicolo ID: ${r.veicolo_id}`);
    console.log(`Modello: ${r.modello}`);
    console.log(`Servizi: ${r.servizi.length ? r.servizi.join(', ') : 'Nessuno'}`);
    console.log(`Posti Totali: ${r.postiTotali}`);
    if (r.tipo === 'slot') {
      console.log(`Posti Richiesti: ${r.postiRichiesti}`);
      console.log(`Origine richiesta: (${r.coordOrigine.lat}, ${r.coordOrigine.lon})`);
      console.log(`Destinazione richiesta: (${r.coordDestinazione.lat}, ${r.coordDestinazione.lon})`);
      console.log(`Ora Partenza: ${r.oraPartenza.toISOString()}`);
      console.log(`Ora Arrivo:   ${r.oraArrivo.toISOString()}`);
      console.log(`Durata stimata: ${(r.durataMs / 60000).toFixed(1)} min`);
    } else {
      console.log(`Posti Disponibili: ${r.postiDisponibili}`);
      console.log(`Origine corsa: (${r.coordOrigine.lat}, ${r.coordOrigine.lon})`);
      console.log(`Destinazione corsa: (${r.coordDestinazione.lat}, ${r.coordDestinazione.lon})`);
      console.log(`Ora Partenza: ${r.oraPartenza.toISOString()}`);
      console.log(`Ora Arrivo:   ${r.oraArrivo.toISOString()}`);
      console.log(`Durata corsa: ${(r.durataMs / 60000).toFixed(1)} min`);
    }
    console.log(`Prezzo: ${r.prezzo.toFixed(2)} €`);
    console.log(`Stato: ${r.stato}`);
    if (r.corseCompatibili.length) {
      console.log(`Corsa compatibile ID: ${r.corseCompatibili.map(c => c.id).join(', ')}`);
    }
    console.log('\n');
  });

  console.log(`Totale risultati: ${results.length}`);
}

testCorsaPrezzoUltra();
