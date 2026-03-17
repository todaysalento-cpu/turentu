// Cache in memoria (oggetto)
const cache = {
  "slot:1": { veicolo_id: 1, coord: { lat: 41.891, lon: 12.495 }, prezzo: 5.00, slot_libero: true },
  "slot:2": { veicolo_id: 2, coord: { lat: 41.892, lon: 12.496 }, prezzo: 5.00, slot_libero: true }
};

// Funzione per visualizzare tutti gli slot nella cache
export function mostraTuttiGliSlot() {
  console.log("Visualizzando tutti gli slot nella cache:");
  Object.keys(cache).forEach((key) => {
    console.log(`${key}:`, cache[key]);
  });
}

// Funzione per verificare la presenza di uno slot
export function verificaSlot(veicolo_id) {
  const key = `slot:${veicolo_id}`;
  const slot = cache[key];
  if (slot) {
    console.log(`Slot con veicolo ID ${veicolo_id}:`, slot);
    return true;
  } else {
    console.log(`Slot con veicolo ID ${veicolo_id} non trovato.`);
    return false;
  }
}

// Funzione per aggiungere uno slot
export function aggiungiSlot(veicolo_id, coord, prezzo, slot_libero) {
  const key = `slot:${veicolo_id}`;
  cache[key] = { veicolo_id, coord, prezzo, slot_libero };
  console.log(`Slot con veicolo ID ${veicolo_id} aggiunto alla cache.`);
}

// Funzione per rimuovere uno slot
export function rimuoviSlot(veicolo_id) {
  const key = `slot:${veicolo_id}`;
  if (cache[key]) {
    delete cache[key];
    console.log(`Slot con veicolo ID ${veicolo_id} rimosso dalla cache.`);
  } else {
    console.log(`Slot con veicolo ID ${veicolo_id} non trovato nella cache.`);
  }
}
