import fetch from "node-fetch";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";

dotenv.config();

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

const TEST_USER = {
  id: 1,
  email: "test@example.com",
  nome: "Test User",
  role: "cliente"
};

// Genera JWT come fa il backend
const TOKEN = jwt.sign(
  { id: TEST_USER.id, email: TEST_USER.email, nome: TEST_USER.nome, role: TEST_USER.role },
  process.env.JWT_SECRET || "segreto-di-test",
  { expiresIn: "1h" }
);

const slots = [
  {
    veicolo_id: 1,
    start_datetime: new Date().toISOString(),
    durata: 60,
    posti_richiesti: 1,
    origine: { lat: 41.8967068, lon: 12.4822025 },
    destinazione: { lat: 45.468503, lon: 9.1824027 }
  }
];

const prezzo = 10.5;

async function main() {
  try {
    console.log("📌 Simulazione creazione PaymentIntent...");

    const res = await fetch(`${API_URL}/booking/payment-intent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Simuliamo cookie come fa il browser
        "Cookie": `token=${TOKEN}`
      },
      body: JSON.stringify({ type: "prenota", prezzo, slots })
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Errore creazione PaymentIntent: ${text}`);
    }

    const data = await res.json();
    console.log("✅ PaymentIntent confermato:", {
      clientSecret: data.clientSecret,
      pending: data.pending,
      requestId: data.requestId,
      amount: prezzo
    });

  } catch (err) {
    console.error("❌ Errore flusso completo:", err);
  }
}

main();
