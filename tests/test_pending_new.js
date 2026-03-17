import axios from "axios";
import pkg from "pg";

const { Pool } = pkg;
const BASE_URL = "http://localhost:3001";

// ✅ Pool configurato sul database corretto
const pool = new Pool({
  user: "postgres",
  host: "localhost",
  database: "corse_db", // database dove esiste la tabella pending
  password: "Malecos83",
  port: 5432,
});

async function runTest() {
  try {
    console.log("\n🚀 TEST AUTOMATICO PAYMENT + PENDING\n");

    // 0️⃣ LOGIN
    const loginRes = await axios.post(
      `${BASE_URL}/auth/login`,
      { email: "test@example.com", password: "PasswordCliente123" },
      { withCredentials: true }
    );

    const cookie = loginRes.headers["set-cookie"]?.[0]?.split(";")[0];
    if (!cookie) throw new Error("Login fallito: cookie mancante");
    console.log("✅ Login riuscito, cookie ottenuti");

    // 1️⃣ CREA PAYMENT INTENT + PENDING
    const now = new Date();
    const paymentRes = await axios.post(
      `${BASE_URL}/booking/payment-intent`,
      {
        type: "prenota",
        prezzo: 30,
        slots: [
          {
            veicolo_id: 1,
            start_datetime: now.toISOString(),
            durata_minuti: 60, // numero di minuti valido per il backend
            posti_richiesti: 1,
            origine: { lat: 45.4642, lon: 9.19 },
            destinazione: { lat: 45.4781, lon: 9.227 },
            tipo_corsa: "privata",
            cliente_id: 1
          }
        ],
        corsaId: null
      },
      { headers: { Cookie: cookie } }
    );

    const pending = paymentRes.data.pending[0];

    console.log(`✅ PaymentIntent creato, Pending registrato | Pending ID: ${pending.id}`);
    console.log('DEBUG pending:', pending);

    // 2️⃣ ACCETTA PENDING
    const acceptRes = await axios.post(
      `${BASE_URL}/pending/${pending.id}/accetta`,
      {},
      { headers: { Cookie: cookie } }
    );

    const { acceptedPendings, prenotazioni } = acceptRes.data;
    console.log("✅ Pending accettato");
    console.log('DEBUG acceptedPendings:', acceptedPendings);
    console.log('DEBUG prenotazioni:', prenotazioni);

    // 3️⃣ VERIFICA DB
    const dbPending = await pool.query(
      "SELECT stato, corsa_id FROM pending WHERE id=$1",
      [pending.id]
    );

    if (!dbPending.rows.length) throw new Error("Pending non trovato nel DB");
    if (dbPending.rows[0].stato !== "accettata") throw new Error("Stato pending non aggiornato");
    if (!dbPending.rows[0].corsa_id) throw new Error("Corsa non creata");

    const pren = await pool.query(
      "SELECT * FROM prenotazioni WHERE cliente_id=$1 ORDER BY id DESC LIMIT 1",
      [pending.cliente_id]
    );

    if (!pren.rows.length) throw new Error("Prenotazione non creata");

    console.log("\n🎉 TEST SUPERATO CON SUCCESSO 🎉");
    console.log("Corsa ID:", dbPending.rows[0].corsa_id, "| Prenotazione ID:", pren.rows[0].id);

  } catch (err) {
    console.error("\n❌ TEST FALLITO:");
    console.error(err.response?.data || err.message);
  } finally {
    await pool.end();
  }
}

runTest();
