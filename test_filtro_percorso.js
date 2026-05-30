import { filterDisponibilita } from './services/search/engine/availability.engine.js'; 

// Mock della Richiesta
const mockRichiesta = {
    posti_richiesti: 1,
    coord: { lat: 43.1, lon: 13.8 }, // Punto intermedio sul percorso
    coordDest: { lat: 43.5, lon: 13.5 } // Punto più avanti
};

// Mock di una Corsa valida
const mockCorse = [{
    id: "test_corsa_001",
    decodedCoords: [
        [42.4, 14.1], // Inizio
        [43.1, 13.8], // Salita richiesta
        [43.5, 13.5], // Discesa richiesta
        [44.0, 12.5]  // Fine
    ],
    posti_totali: 4,
    picco_occupazione: 0,
    numero_prenotazioni_attive: 0,
    fermate_pianificate: []
}];

function runTest() {
    console.log("--- ESECUZIONE TEST DI FILTRAGGIO ---");
    
    const result = filterDisponibilita(
        mockRichiesta, 
        [], // veicoliCache
        [], // disponibilitaCache
        mockCorse, 
        []  // puntiRaccolta
    );

    console.log(`Risultato: Trovate ${result.corse.length} corse.`);
    
    if (result.corse.length > 0) {
        console.log("✅ Test superato: Corsa rilevata correttamente.");
        console.log("Dettaglio:", JSON.stringify(result.corse[0].percorsoVisualizzato, null, 2));
    } else {
        console.error("❌ Test fallito: La corsa è stata scartata (controlla i [DEBUG] log nel terminale).");
    }
}

runTest();