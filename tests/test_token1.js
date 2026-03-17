// test_token1.js
import { io } from "socket.io-client";

const socket = io("http://localhost:3001", {
  auth: {
    token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6Miwicm9sZSI6ImF1dGlzdGEiLCJlbWFpbCI6Im1hcmlvLnJvc3NpQGV4YW1wbGUuY29tIiwibm9tZSI6Ik1hcmlvIFJvc3NpIiwiaWF0IjoxNzcyODk4MzA4LCJleHAiOjE3NzM1MDMxMDh9.wfOFseAyR1H02mnIhxJtD4K69xsMLgijvqC0F31L_CQ"
  }
});

socket.on("connect", () => {
  console.log("✅ Connesso con socket id:", socket.id);
});

socket.on("connect_error", (err) => {
  console.error("❌ Errore connessione:", err.message);
});

socket.on("new_message", (msg) => {
  console.log("💬 Messaggio ricevuto:", msg);
});