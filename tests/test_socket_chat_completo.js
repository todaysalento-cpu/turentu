import { io } from "socket.io-client";

// ---------------- CONFIG ----------------
const SOCKET_URL = "http://localhost:3001"; // URL del tuo server Socket.io
const CORSA_ID = 1; // ID della corsa da testare

// JWT simulati per autista e cliente
const AUTISTA_TOKEN = "INSERISCI_IL_JWT_AUTISTA";
const CLIENTE_TOKEN = "INSERISCI_IL_JWT_CLIENTE";

// ---------------- CONNESSIONE SOCKET ----------------
function connectSocket(role, token) {
  const socket = io(SOCKET_URL, {
    auth: { token },
    transports: ["websocket"],
  });

  socket.on("connect", () => {
    console.log(`🔌 ${role} connesso con ID: ${socket.id}`);
    // Unisciti alla room della corsa
    socket.emit("join_corsa_chat", CORSA_ID);
  });

  socket.on("new_message", (msg) => {
    console.log(`📩 [${role} riceve]`, msg.user, ":", msg.text);
  });

  socket.on("typing", () => {
    console.log(`⌨️ [${role}] L'altro sta scrivendo...`);
  });

  socket.on("disconnect", () => {
    console.log(`🔴 ${role} disconnesso`);
  });

  return socket;
}

// ---------------- SIMULAZIONE CHAT ----------------
async function testChat() {
  const autistaSocket = connectSocket("Autista", AUTISTA_TOKEN);
  const clienteSocket = connectSocket("Cliente", CLIENTE_TOKEN);

  // Attendi un paio di secondi per connessione
  await new Promise((r) => setTimeout(r, 2000));

  // Invia messaggi alternati
  autistaSocket.emit("send_message", {
    corsa_id: CORSA_ID,
    text: "Ciao Cliente, sto arrivando!",
  });

  await new Promise((r) => setTimeout(r, 1000));

  clienteSocket.emit("send_message", {
    corsa_id: CORSA_ID,
    text: "Perfetto, ti vedo davanti!",
  });

  // Simula typing
  autistaSocket.emit("typing", { corsa_id: CORSA_ID });
  await new Promise((r) => setTimeout(r, 1500));

  clienteSocket.emit("typing", { corsa_id: CORSA_ID });

  // Lascia la chat aperta per 5 secondi per vedere i messaggi in console
  await new Promise((r) => setTimeout(r, 5000));

  autistaSocket.disconnect();
  clienteSocket.disconnect();
  console.log("✅ Test chat completato");
}

testChat();