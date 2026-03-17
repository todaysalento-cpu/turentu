import 'dotenv/config';
import { cercaSlotUltra } from './search.service.js';

async function testCercaSlotUltra() {
  try {
    const richiesta = {
      coord: { lat: 41.89332, lon: 12.48293 },          // Origine richiesta
      coordDest: { lat: 45.46419, lon: 9.18963 },       // Destinazione richiesta
      start_datetime: new Date(),                        // Ora di partenza richiesta
      posti_richiesti: 2
    };

    console.log('📦 Caricamento cache e ricerca...');

    const risultati = await cercaSlotUltra(richiesta);

    console.log(`✅ Risultati trovati: ${risultati.length}\n`);

    risultati.forEach((r, i) => {
      console.log(`================ RISULTATO ${i + 1} =================`);
      console.log(`Tipo: ${r.tipo}`);
      console.log(`Veicolo: ${r.modello} (ID: ${r.veicolo_id})`);
      console.log(`Stato: ${r.stato} | Prezzo: ${r.prezzo.toFixed(2)} € | Euro/km: ${r.euro_km ?? '-'}`);
      console.log(`Posti: richiesti ${r.postiRichiesti ?? '-'} / totali ${r.postiTotali ?? '-'}`);
      console.log(`Origine: ${r.coordOrigine.lat}, ${r.coordOrigine.lon}`);
      console.log(`Destinazione: ${r.coordDestinazione.lat}, ${r.coordDestinazione.lon}`);
      console.log(`Partenza: ${r.oraPartenza}`);
      console.log(`Arrivo: ${r.oraArrivo}`);
      console.log(`Durata (ms): ${r.durataMs} | Distanza (km): ${r.distanzaKm.toFixed(2)}`);
      console.log(`Corse compatibili: ${r.corseCompatibili.length}`);

      if (r.tipo === 'corsa' && r.corseCompatibili.length > 0) {
        const c = r.corseCompatibili[0];
        console.log('--- DATI CORSA REALE ---');
        console.log(`Origine reale: ${c.origine_lat}, ${c.origine_lon}`);
        console.log(`Destinazione reale: ${c.dest_lat}, ${c.dest_lon}`);
        console.log(`Start datetime: ${c.start_datetime}`);
        console.log(`Durata (s): ${c.durata ?? 'N/A'}`);
        console.log(`Posti disponibili: ${c.posti_disponibili ?? 'N/A'}`);
        console.log(`Distanza corsa (km): ${c.distanza ?? 'N/A'}`);
        console.log(`Posti prenotati: ${c.posti_prenotati ?? 'N/A'}`);
        console.log(`Primo posto: ${c.primo_posto ?? 'N/A'}`);
      }

      console.log('===============================================\n');
    });
  } catch (err) {
    console.error('💥 Errore test:', err);
  }
}

testCercaSlotUltra();
