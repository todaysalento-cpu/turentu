import { fetchCorse } from './db/db.js';
import { filterDisponibilita } from './services/search/engine/availability.engine.js';

async function runExtendedScenarioTest() {
  const corse = await fetchCorse();
  
  // Scenari estesi per validare la corsa 683 (Roma -> Milano) in vari segmenti
  const scenari = [
    { nome: "Intera Tratta", coord: { lat: 41.8967, lon: 12.4822 }, dest: { lat: 45.4642, lon: 9.1900 }, origName: "Roma", destName: "Milano" },
    { nome: "Segmento Iniziale", coord: { lat: 41.8967, lon: 12.4822 }, dest: { lat: 43.7696, lon: 11.2558 }, origName: "Roma", destName: "Firenze" },
    { nome: "Segmento Centrale", coord: { lat: 43.7696, lon: 11.2558 }, dest: { lat: 44.4949, lon: 11.3426 }, origName: "Firenze", destName: "Bologna" },
    { nome: "Segmento Finale", coord: { lat: 44.4949, lon: 11.3426 }, dest: { lat: 45.4642, lon: 9.1900 }, origName: "Bologna", destName: "Milano" },
    { nome: "Direzione Opposta", coord: { lat: 45.4642, lon: 9.1900 }, dest: { lat: 41.8967, lon: 12.4822 }, origName: "Milano", destName: "Roma" }
  ];

  console.log("🔍 [TEST] Avvio analisi segmentazione corsa 683...");

  for (const s of scenari) {
    console.log(`\n--- Scenario: ${s.nome} (${s.origName} -> ${s.destName}) ---`);
    
    const richiesta = {
      coord: s.coord,
      coordDest: s.dest,
      posti_richiesti: 1
    };

    const result = await filterDisponibilita(richiesta, corse, corse.map(() => []));

    if (result.corse.length > 0) {
      console.table(result.corse.map(c => ({
        ID: c.id,
        Tratta_DB: `${c.origine_address} -> ${c.destinazione_address}`,
        Origine_Rich: s.origName,
        Dest_Rich: s.destName
      })));
    } else {
      console.log(`⚠️ Nessuna corsa trovata per ${s.nome}.`);
    }
  }
}

runExtendedScenarioTest().catch(console.error);