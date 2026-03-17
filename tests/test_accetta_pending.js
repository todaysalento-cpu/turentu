import fetch from "node-fetch";
import fetchCookie from "fetch-cookie";

const fetchWithCookie = fetchCookie(fetch);

async function testPagamento() {
  try {
    console.log("🚀 Inizio test pagamento");

    const API_URL = "http://localhost:3001";

    // ------------------- STEP 0: LOGIN -------------------
    console.log("🔑 Effettuo login...");
    const loginRes = await fetchWithCookie(`${API_URL}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "test@example.com", password: "PasswordCliente123" })
    });

    console.log("Login status:", loginRes.status);

    if (!loginRes.ok) {
      const text = await loginRes.text();
      throw new Error(`Login fallito: ${text}`);
    }
    console.log("✅ Login riuscito, cookie salvati");

    // ------------------- STEP 1: CREA PENDING / PAYMENT INTENT -------------------
    const slots = [
      {
        veicolo_id: 1,
        start_datetime: new Date().toISOString(),
        durata: 30,
        posti_richiesti: 2,
        origine: { lat: 45.4642, lon: 9.19 },
        destinazione: { lat: 45.4781, lon: 9.227 },
        localitaOrigine: "Milano Centrale",
        localitaDestinazione: "Milano Porta Romana"
      }
    ];

    const tipo = "condivisa";
    const prezzo = 15.0;

    console.log("📤 Chiamo /booking/payment-intent...");
    const res = await fetchWithCookie(`${API_URL}/booking/payment-intent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: tipo, prezzo, slots })
    });

    const resText = await res.text();
    let data;
    try { data = JSON.parse(resText); } 
    catch { data = null; }

    if (!res.ok) {
      console.error("Risposta /booking/payment-intent:", resText);
      throw new Error(`Errore backend: ${resText}`);
    }

    console.log("✅ Pending creati:", data.pending);
    const pending_id = data.pending[0].id;

    // ------------------- STEP 2: ACCETTA PENDING -------------------
    console.log(`📤 Chiamo /pending/${pending_id}/accetta per simulare accettazione...`);
    const acceptRes = await fetchWithCookie(`${API_URL}/pending/${pending_id}/accetta`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allSlots: false })
    });

    const acceptText = await acceptRes.text();
    let acceptData;
    try { acceptData = JSON.parse(acceptText); } 
    catch { acceptData = null; }

    console.log("Accept pending status:", acceptRes.status);
    if (!acceptRes.ok) {
      console.error("Risposta /pending/:id/accetta:", acceptText);
      throw new Error(`Errore accettazione pending: ${acceptText}`);
    }

    console.log("✅ Pending accettato, corsa e prenotazione create:", acceptData);

    console.log("🎉 Test completato con successo!");

  } catch (err) {
    console.error("❌ Test fallito:", err);
  }
}

// Avvia il test
testPagamento();
