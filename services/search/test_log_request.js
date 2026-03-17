import fetch from "node-fetch";

// Corpo della richiesta (modifica se vuoi testare altre città)
const requestBody = {
  localitaOrigine: "Roma",
  coord: { lat: 41.9028, lon: 12.4964 },
  localitaDestinazione: "Napoli",
  coordDest: { lat: 40.8518, lon: 14.2681 },
  start_datetime: new Date().toISOString(),
  posti_richiesti: 1
};

async function testSearch() {
  try {
    console.log("📤 Richiesta inviata:", requestBody);

    const res = await fetch("http://localhost:3001/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody)
    });

    const data = await res.json();
    console.log("📥 Risposta ricevuta:", data);
  } catch (err) {
    console.error("❌ Errore:", err);
  }
}

testSearch();