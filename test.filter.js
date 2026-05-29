// Aggiornato: percorso corretto verso il motore di ricerca
import { filterDisponibilita } from './services/search/engine/availability.engine.js';

async function runTest() {
  console.log("🚀 Avvio Test Filtro Disponibilità (Engine)...");

  // Mock dei dati
  const richiesta = {
    start_datetime: new Date().toISOString(),
    posti_richiesti: 1,
    coord: { lat: 45.463, lon: 9.190 },
    coordDest: { lat: 45.465, lon: 9.195 }
  };

  const veicoliCache = [{ id: 66, posti_totali: 4, lat: 45.46, lon: 9.19 }];
  const disponibilitaCache = [{ 
    veicolo_id: 66, 
    start: '2026-05-27T08:00:00Z', 
    fine: '2026-05-27T20:00:00Z' 
  }];
  
  // Corsa mock con polyline (linea retta che passa vicino ai punti richiesta)
  const corseCache = [{
    id: 1,
    veicolo_id: 66,
    posti_totali: 4,
    picco_occupazione: 2,
    path_geohashes: ['u0nd6'], 
    percorso_polyline: [[9.18, 45.46], [9.20, 45.47]],
    start_datetime: new Date().toISOString(),
    arrivo_datetime: new Date(Date.now() + 3600000).toISOString(),
    stato: 'prenotabile'
  }];

  try {
    const risultati = filterDisponibilita(richiesta, veicoliCache, disponibilitaCache, corseCache);

    console.log("--- Risultati Filtro ---");
    console.log(`Slot trovati: ${risultati.slots?.length || 0}`);
    console.log(`Corse ridesharing trovate: ${risultati.corse?.length || 0}`);

    if (risultati.corse && risultati.corse.length > 0) {
      console.log("✅ TEST PASSATO: La corsa è stata filtrata correttamente.");
    } else {
      console.log("❌ TEST FALLITO: La corsa è stata scartata (controlla tolleranze geo).");
    }
  } catch (err) {
    console.error("💥 Errore durante il test:", err);
  }
}

runTest();