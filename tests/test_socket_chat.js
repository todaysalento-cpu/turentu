// tests/test_socket.js
import { io } from "socket.io-client";

const token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6MTAxLCJyb2xlIjoiY2xpZW50ZSIsImVtYWlsIjoibWFyaW9AZXhhbXBsZS5jb20iLCJub21lIjoiTWFyaW8gUm9zc2kiLCJpYXQiOjE3NzI4OTI5MzYsImV4cCI6MTc3MzQ5NzczNn0.K-OOLjyRlnwzfi1AhctM3MLwm5NQQvt-m-1aNr7fd50"; // inserisci un token valido

const socket = io("http://localhost:3001", {
  auth: { token },
  transports: ["websocket"],
});

socket.on("connect", () => {
  console.log("🔌 Connesso al server Socket.io con ID:", socket.id);
});

socket.on("connect_error", (err) => {
  console.error("❌ Errore connessione:", err.message);
});

socket.on("new_message", (msg) => {
  console.log("📩 Nuovo messaggio:", msg);
});

// Invia un messaggio di test dopo 2 secondi
setTimeout(() => {
  socket.emit("send_message", { corsa_id: 1, text: "Ciao dal test Node!" });
}, 2000);