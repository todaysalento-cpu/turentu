
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import express from "express";
import jwt from "jsonwebtoken";
import { pool } from "../db/db.js";

await import("dotenv/config");

// Firebase disabilitato esclusivamente in questo processo.
process.env.FIREBASE_SERVICE_ACCOUNT = "";

const { default: chatRouter } = await import("../routes/chat.routes.js");
const { cloudinary } = await import("../services/cloudinary.js");

const corsaId = 925;
const clienteId = 101;
const driverId = 2;
const clientMsgId = `turentu-http-test-${randomUUID()}`;
const jwtSecret = process.env.JWT_SECRET || "segreto-di-test";

let uploadCalls = 0;
let notificationAttempts = 0;
let pushTokenLookups = 0;

const originalUpload = cloudinary.uploader.upload_stream;
const originalQueryFn = pool.query;
const originalQuery = originalQueryFn.bind(pool);

let server;

const app = express();
app.use(express.json({ limit: "50mb" }));
app.use("/api/chat", chatRouter);

const tokenAutista = jwt.sign(
  { id: driverId, role: "autista" },
  jwtSecret,
  { expiresIn: "5m" }
);

const tokenCliente = jwt.sign(
  { id: clienteId, role: "cliente" },
  jwtSecret,
  { expiresIn: "5m" }
);

// Simulazione Cloudinary
cloudinary.uploader.upload_stream = (options, callback) => {
  uploadCalls++;

  return new Writable({
    write(chunk, encoding, done) {
      done();
    },
    final(done) {
      callback(null, {
        secure_url: "https://test.invalid/turentu-audio.m4a"
      });
      done();
    }
  });
};

// Isolamento delle notifiche:
// nessuna scrittura reale e nessun token FCM restituito.
pool.query = async function (...args) {
  const sql = typeof args[0] === "string"
    ? args[0]
    : args[0]?.text || "";

  if (/INSERT\s+INTO\s+notifications/i.test(sql)) {
    notificationAttempts++;

    return {
      rows: [{
        id: -900001,
        user_id: driverId,
        type: "chat",
        message: "Hai ricevuto un file",
        seen: false,
        created_at: new Date()
      }]
    };
  }

  if (/SELECT\s+push_token\s+FROM\s+utente_push_tokens/i.test(sql)) {
    pushTokenLookups++;
    return { rows: [] };
  }

  return originalQuery.apply(this, args);
};

async function postMessage(token) {
  return fetch(`http://127.0.0.1:${server.address().port}/api/chat/messages/media`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      corsa_id: corsaId,
      cliente_id: clienteId,
      client_msg_id: clientMsgId,
      tipo_messaggio: "audio",
      duration: 3,
      audio_base64:
        "data:audio/m4a;base64," +
        Buffer.from("TURENTU_TEST_AUDIO").toString("base64")
    })
  });
}

try {
  server = await new Promise((resolve, reject) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
    s.once("error", reject);
  });

  console.log("HTTP TEST SERVER:", server.address().port);

  // Verifica accesso autorizzato prima del test.
  const access = await originalQuery(
    `SELECT 1 FROM chat_threads
     WHERE corsa_id=$1 AND cliente_id=$2 AND driver_id=$3`,
    [corsaId, clienteId, driverId]
  );

  assert.ok(access.rows.length, "Chat di test non autorizzata");

  // 1. PRIMO INVIO AUDIO
  const firstResponse = await postMessage(tokenAutista);
  const firstBody = await firstResponse.json();

  assert.equal(firstResponse.status, 200);
  assert.ok(firstBody.id);
  assert.equal(firstBody.client_msg_id, clientMsgId);

  const firstId = Number(firstBody.id);

  console.log("OK: primo invio HTTP", firstId);

  // 2. RETRY CON IDENTIFICATIVO IDENTICO
  const retryResponse = await postMessage(tokenAutista);
  const retryBody = await retryResponse.json();

  assert.equal(retryResponse.status, 200);
  assert.equal(Number(retryBody.id), firstId);

  console.log("OK: retry restituisce lo stesso messaggio");

  // 3. IDENTIFICATIVO RIUTILIZZATO DA ALTRO MITTENTE
  const conflictResponse = await postMessage(tokenCliente);

  assert.equal(conflictResponse.status, 409);

  console.log("OK: conflitto altro mittente HTTP 409");

  // 4. CONTEGGIO POSTGRESQL
  const count = await originalQuery(
    `SELECT COUNT(*)::int AS total
     FROM messaggi
     WHERE client_msg_id=$1`,
    [clientMsgId]
  );

  assert.equal(count.rows[0].total, 1);

  console.log("OK: un solo record PostgreSQL");

  // 5. VERIFICA UPLOAD
  assert.equal(uploadCalls, 1);

  console.log("OK: un solo upload Cloudinary simulato");

  // 6. VERIFICA NOTIFICHE
  assert.equal(notificationAttempts, 1);
  assert.equal(pushTokenLookups, 1);

  console.log("OK: una sola richiesta notifiche simulata");
  console.log("OK: nessun token FCM utilizzato");
  console.log("OK: nessuna scrittura reale notifications");

  console.log("\nRISULTATO: TEST HTTP SUPERATO");

} catch (error) {
  console.error("\nTEST FALLITO:", error);
  process.exitCode = 1;

} finally {
  if (server) {
    await new Promise(resolve => server.close(resolve));
  }

  // Ripristino delle dipendenze originali.
  cloudinary.uploader.upload_stream = originalUpload;
  pool.query = originalQueryFn;

  // Cancellazione esclusiva del messaggio generato dal test.
  try {
    const deleted = await originalQuery(
      `DELETE FROM messaggi
       WHERE client_msg_id=$1
         AND corsa_id=$2
         AND cliente_id=$3
         AND sender_id=$4
       RETURNING id`,
      [clientMsgId, corsaId, clienteId, driverId]
    );

    if (deleted.rows.length) {
      console.log("OK: messaggio temporaneo eliminato:", deleted.rows[0].id);
    } else {
      console.log("OK: nessun record temporaneo da eliminare");
    }

  } catch (error) {
    console.error("ERRORE PULIZIA:", error.message);
    process.exitCode = 1;
  }

  await pool.end();
}
