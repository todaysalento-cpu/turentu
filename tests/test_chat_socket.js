// tests/test_chat_socket.js
import { io } from "socket.io-client";

const SOCKET_URL = "http://localhost:3001";
const CORSA_ID = 42; // ID corsa di test

// Token simulati (dal backend)
const autistaToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6NSwicm9sZSI6ImF1dGlzdGEiLCJlbWFpbCI6Im51b3ZvLmF1dGlzdGFAZXhhbXBsZS5jb20iLCJub21lIjoiTnVvdm8gQXV0aXN0YSIsImlhdCI6MTc3MzA3NDMxMywiZXhwIjoxNzczNjc5MTEzfQ.JDAXWUFHA-ggEyST2p9v-omm5CUvFUnbV6W-97fgTFE";
const clienteToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6MTAxLCJyb2xlIjoiY2xpZW50ZSIsImVtYWlsIjoibWFyaW9AZXhhbXBsZS5jb20iLCJub21lIjoiTWFyaW8gUm9zc2kiLCJpYXQiOjE3NzMwNTIyNjksImV4cCI6MTc3MzY1NzA2OX0.uX4njZWJD2V-4gU_ZPJ_ANq5RMbWGarGxNYEiNU_S4c";

function createClient(role, token) {
  const socket = io(SOCKET_URL, {
    transports: ["websocket"],
    auth: { token },
  });

  socket.on("connect", () => {
    console.log(`[${role}] 🟢 Connesso con ID`, socket.id);

    // Join alla room della corsa
    socket.emit("join_corsa_chat", CORSA_ID);
  });

  socket.on("disconnect", (reason) => {
    console.log(`[${role}] 🔴 Disconnesso | reason:`, reason);
  });

  socket.on("new_message", (msg) => {
    console.log(`[${role}] 💬 Messaggio ricevuto:`, msg);
  });

  return socket;
}

async function main() {
  const autista = createClient("Autista", autistaToken);
  const cliente = createClient("Cliente", clienteToken);

  // Dopo 2 secondi, l'autista invia un messaggio
  setTimeout(() => {
    console.log("[Autista] ✉️ Invio messaggio...");
    autista.emit("send_message", { corsa_id: CORSA_ID, text: "Ciao Cliente!" });
  }, 2000);

  // Dopo 4 secondi, il cliente risponde
  setTimeout(() => {
    console.log("[Cliente] ✉️ Invio messaggio...");
    cliente.emit("send_message", { corsa_id: CORSA_ID, text: "Ciao Autista!" });
  }, 4000);

  // Chiudi tutto dopo 6 secondi
  setTimeout(() => {
    autista.disconnect();
    cliente.disconnect();
    console.log("🧹 Test completato, socket disconnessi.");
    process.exit(0);
  }, 6000);
}

main();