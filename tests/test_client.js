import { io } from "socket.io-client";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "segreto-di-test";

// ======================= GENERA TOKEN DI TEST =======================
const token = jwt.sign(
  { id: 1, role: "Cliente" }, // cambia id e role per test autista
  JWT_SECRET,
  { expiresIn: "1h" }
);

console.log("🔑 Token generato:", token);

// ======================= CONNETTI SOCKET ===========================
const socket = io("http://localhost:3001", {
  auth: { token },
});

socket.on("connect", () => {
  console.log("🟢 Connesso al server:", socket.id);

  // Join stanza della corsa
  const corsaId = 1;
  socket.emit("join_corsa_chat", corsaId);
  console.log(`🔵 Join stanza corsa_${corsaId}`);

  // Invia un messaggio di test
  const testMessage = "Messaggio di test dal client";
  socket.emit("send_message", { corsa_id: corsaId, text: testMessage });
  console.log("📤 Inviato messaggio:", testMessage);
});

// ======================= RICEVI NUOVI MESSAGGI =====================
socket.on("new_message", (msg) => {
  console.log("📨 Messaggio ricevuto:", msg);

  // Marca automaticamente come letto
  if (!msg.read_status?.Cliente) {
    fetch(`http://localhost:3001/chat/${msg.corsa_id}/read`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
    }).then(() => {
      console.log(`✔️ Messaggio ${msg.id} marcato come letto`);
    });
  }
});

// ======================= RICEVI CONTEGGIO NON LETTI ==================
socket.on("unread_count", ({ corsa_id, count }) => {
  console.log(`📊 Messaggi non letti per corsa_${corsa_id}:`, count);
});

// ======================= GESTIONE DISCONNESSIONE ===================
socket.on("disconnect", () => {
  console.log("🔴 Disconnesso dal server");
});

socket.on("connect_error", (err) => {
  console.error("❌ Errore connessione:", err.message);
});