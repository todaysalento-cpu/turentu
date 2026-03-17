// Importa le funzioni dal modulo
import { mostraTuttiGliSlot, verificaSlot, aggiungiSlot, rimuoviSlot } from './test_cache_slot.js';

// Test: Visualizza tutti gli slot iniziali nella cache
console.log("Test 1: Visualizzare tutti gli slot iniziali nella cache");
mostraTuttiGliSlot();

// Test: Verifica se uno slot con veicolo_id 1 esiste
console.log("\nTest 2: Verifica presenza slot con veicolo_id 1");
verificaSlot(1);  // Dovrebbe mostrare i dettagli dello slot con veicolo_id 1

// Test: Verifica se uno slot con veicolo_id 3 esiste (non esiste)
console.log("\nTest 3: Verifica presenza slot con veicolo_id 3");
verificaSlot(3);  // Dovrebbe mostrare un messaggio che lo slot non esiste

// Test: Aggiungi uno slot con veicolo_id 3
console.log("\nTest 4: Aggiungere uno slot con veicolo_id 3");
aggiungiSlot(3, { lat: 41.893, lon: 12.497 }, 5.50, false);

// Test: Visualizzare tutti gli slot dopo l'aggiunta di uno slot nuovo
console.log("\nTest 5: Visualizzare tutti gli slot dopo l'aggiunta di uno slot nuovo");
mostraTuttiGliSlot();

// Test: Rimuovi lo slot con veicolo_id 1
console.log("\nTest 6: Rimuovere lo slot con veicolo_id 1");
rimuoviSlot(1);

// Test: Visualizzare tutti gli slot dopo la rimozione dello slot con veicolo_id 1
console.log("\nTest 7: Visualizzare tutti gli slot dopo la rimozione dello slot con veicolo_id 1");
mostraTuttiGliSlot();
