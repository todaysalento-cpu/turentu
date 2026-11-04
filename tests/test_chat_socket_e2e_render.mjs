import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import express from "express";
import jwt from "jsonwebtoken";
import { Server } from "socket.io";
import { io as Client } from "socket.io-client";

await import("dotenv/config");

process.env.FIREBASE_SERVICE_ACCOUNT = "";
process.env.JWT_SECRET ||= "segreto-di-test";

const { pool } = await import("../db/db.js");
const { setupSocket } = await import("../socket.js");
const { default: chatRouter } = await import("../routes/chat.routes.js");

const corsaId = 925;
const clienteId = 101;
const driverId = 2;
const clientMsgId = `turentu-socket-e2e-${randomUUID()}`;
const jwtSecret = process.env.JWT_SECRET;

const app = express();
app.use(express.json({ limit: "50mb" }));
app.use("/api/chat", chatRouter);

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

setupSocket(io);

let cliente;
let autista;
let estraneo;
let messageId = null;
let failure = null;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function waitEvent(socket, event, predicate = () => true, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timeout evento ${event}`));
    }, timeout);

    function handler(data) {
      if (!predicate(data)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(data);
    }

    socket.on(event, handler);
  });
}

function connect(userId, role) {
  const token = jwt.sign(
    { id: userId, role },
    jwtSecret,
    { expiresIn: "5m" }
  );

  return new Promise((resolve, reject) => {
    const socket = Client(
      `http://127.0.0.1:${server.address().port}`,
      {
        transports: ["websocket"],
        reconnection: false,
        auth: { token }
      }
    );

    const timer = setTimeout(() => {
      socket.disconnect();
      reject(new Error(`Timeout connessione ${role}`));
    }, 8000);

    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });

    socket.once("connect_error", error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function sendWithAck(socket, payload) {
  return new Promise((resolve, reject) => {
    socket.timeout(8000).emit("send_message", payload, (error, response) => {
      if (error) return reject(error);
      resolve(response);
    });
  });
}

try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  console.log("SERVER:", server.address().port);

  const access = await pool.query(
    `SELECT 1 FROM chat_threads
     WHERE corsa_id=$1 AND cliente_id=$2 AND driver_id=$3`,
    [corsaId, clienteId, driverId]
  );

  assert.ok(access.rows.length, "Chat non autorizzata");

  // Verifica che non esistano ricevute di lettura pendenti.
  const unread = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM messaggi m
     LEFT JOIN message_receipts r
       ON r.message_id=m.id AND r.user_id=$3
     WHERE m.corsa_id=$1 AND m.cliente_id=$2
       AND m.sender_id=$4 AND r.read_at IS NULL`,
    [corsaId, clienteId, clienteId, driverId]
  );

  assert.equal(unread.rows[0].total, 0);
  console.log("OK: nessuna lettura pendente preesistente");

  // 1. CONNESSIONE
  cliente = await connect(clienteId, "cliente");
  autista = await connect(driverId, "autista");
  estraneo = await connect(999, "autista");

  console.log("OK: tre connessioni Socket.IO reali");

  cliente.emit("join_chat", {
    corsa_id: corsaId,
    cliente_id: clienteId
  });

  autista.emit("join_chat", {
    corsa_id: corsaId,
    cliente_id: clienteId
  });

  await sleep(300);

  // 2. INVIO E RICEZIONE
  let receivedCount = 0;

  cliente.on("new_message", () => receivedCount++);

  const receivedPromise = waitEvent(
    cliente,
    "new_message",
    msg => msg.client_msg_id === clientMsgId
  );

  const ack = await sendWithAck(autista, {
    corsa_id: corsaId,
    cliente_id: clienteId,
    client_msg_id: clientMsgId,
    text: "TURENTU E2E TEST",
    tipo_messaggio: "text"
  });

  assert.equal(ack.ok, true);
  assert.equal(ack.duplicate, false);

  const message = await receivedPromise;
  messageId = Number(message.id);

  assert.ok(messageId > 0);

  console.log("OK: ACK e ricezione messaggio", messageId);

  // 3. RETRY IDEMPOTENTE
  const retry = await sendWithAck(autista, {
    corsa_id: corsaId,
    cliente_id: clienteId,
    client_msg_id: clientMsgId,
    text: "TURENTU E2E TEST",
    tipo_messaggio: "text"
  });

  assert.equal(retry.ok, true);
  assert.equal(retry.duplicate, true);
  assert.equal(Number(retry.message.id), messageId);

  await sleep(300);

  assert.equal(receivedCount, 1);

  console.log("OK: retry senza duplicazione");

  // 4. CONSEGNA
  const deliveredPromise = waitEvent(
    autista,
    "message_delivered",
    data => data.message_ids?.includes(String(messageId))
  );

  cliente.emit("message_delivered", {
    message_id: messageId,
    corsa_id: corsaId,
    cliente_id: clienteId
  });

  await deliveredPromise;

  const delivered = await pool.query(
    `SELECT delivered_at FROM message_receipts
     WHERE message_id=$1 AND user_id=$2`,
    [messageId, clienteId]
  );

  assert.ok(delivered.rows[0]?.delivered_at);

  console.log("OK: consegna registrata su Render");

  // 5. LETTURA
  const unreadTest = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM messaggi m
     LEFT JOIN message_receipts r
       ON r.message_id=m.id AND r.user_id=$3
     WHERE m.corsa_id=$1 AND m.cliente_id=$2
       AND m.sender_id=$4 AND r.read_at IS NULL`,
    [corsaId, clienteId, clienteId, driverId]
  );

  assert.equal(unreadTest.rows[0].total, 1);

  const readPromise = waitEvent(
    autista,
    "message_read",
    data => data.message_ids?.includes(String(messageId))
  );

  const readResponse = await fetch(
    `http://127.0.0.1:${server.address().port}/api/chat/messages/read`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt.sign(
          { id: clienteId, role: "cliente" },
          jwtSecret,
          { expiresIn: "5m" }
        )}`
      },
      body: JSON.stringify({
        corsa_id: corsaId,
        cliente_id: clienteId
      })
    }
  );

  assert.equal(readResponse.status, 200);
  assert.equal((await readResponse.json()).success, true);

  const readEvent = await readPromise;

  assert.ok(readEvent.message_ids.includes(String(messageId)));

  const receipt = await pool.query(
    `SELECT delivered_at, read_at
     FROM message_receipts
     WHERE message_id=$1 AND user_id=$2`,
    [messageId, clienteId]
  );

  assert.ok(receipt.rows[0]?.delivered_at);
  assert.ok(receipt.rows[0]?.read_at);

  console.log("OK: doppia conferma consegna e lettura");

  // 6. CONFLITTO IDENTIFICATIVO
  const conflict = await sendWithAck(cliente, {
    corsa_id: corsaId,
    cliente_id: clienteId,
    client_msg_id: clientMsgId,
    text: "MESSAGGIO NON AUTORIZZATO",
    tipo_messaggio: "text"
  });

  assert.equal(conflict.ok, false);
  assert.equal(conflict.error, "MESSAGE_ID_CONFLICT");

  console.log("OK: identificativo protetto da altro mittente");

  // 7. UTENTE ESTRANEO
  const outsiderJoin = await pool.query(
    `SELECT 1 FROM chat_threads
     WHERE corsa_id=$1 AND cliente_id=$2
       AND (cliente_id=999 OR driver_id=999)`,
    [corsaId, clienteId]
  );

  assert.equal(outsiderJoin.rows.length, 0);

  const forbidden = await sendWithAck(estraneo, {
    corsa_id: corsaId,
    cliente_id: clienteId,
    client_msg_id: `outsider-${randomUUID()}`,
    text: "ACCESSO NON AUTORIZZATO"
  });

  assert.equal(forbidden.ok, false);
  assert.equal(forbidden.error, "CHAT_ACCESS_DENIED");

  console.log("OK: utente estraneo rifiutato");

  // 8. VERIFICA RECORD
  const count = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM messaggi WHERE client_msg_id=$1`,
    [clientMsgId]
  );

  assert.equal(count.rows[0].total, 1);

  console.log("\nRISULTATO: SOCKET.IO E2E SUPERATO");

} catch (error) {
  failure = error;
  console.error("\nTEST FALLITO:", error);

} finally {
  for (const socket of [cliente, autista, estraneo]) {
    if (socket) socket.disconnect();
  }

  // Pulizia esclusivamente del messaggio generato dal test.
  try {
    if (messageId) {
      await pool.query(
        `DELETE FROM message_receipts WHERE message_id=$1`,
        [messageId]
      );
    }

    const deleted = await pool.query(
      `DELETE FROM messaggi
       WHERE client_msg_id=$1
         AND corsa_id=$2
         AND cliente_id=$3
         AND sender_id=$4
       RETURNING id`,
      [clientMsgId, corsaId, clienteId, driverId]
    );

    console.log(
      "PULIZIA:",
      deleted.rows.length ? "messaggio eliminato" : "nessun record temporaneo"
    );

  } catch (error) {
    console.error("ERRORE PULIZIA:", error);
    failure = failure || error;
  }

  await new Promise(resolve => io.close(resolve));
  await pool.end();

  if (failure) process.exitCode = 1;
}