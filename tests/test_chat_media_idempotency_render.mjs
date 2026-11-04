
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "../db/db.js";

const corsaId = 925;
const clienteId = 101;
const senderId = 2;
const clientMsgId = `turentu-media-test-${randomUUID()}`;

const lockSql =
  "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))";

let a;
let b;
let aOpen = false;
let bOpen = false;
let firstId = null;

try {
  a = await pool.connect();
  b = await pool.connect();

  // Verifica autorizzazione della chat
  const access = await a.query(
    `SELECT 1 FROM chat_threads
     WHERE corsa_id=$1 AND cliente_id=$2
     AND (cliente_id=$3 OR driver_id=$3)`,
    [corsaId, clienteId, senderId]
  );

  assert.ok(access.rows.length, "Chat non autorizzata");

  // PRIMA RICHIESTA
  await a.query("BEGIN");
  aOpen = true;

  await a.query(lockSql, [clientMsgId]);

  const previous = await a.query(
    "SELECT id FROM messaggi WHERE client_msg_id=$1",
    [clientMsgId]
  );

  assert.equal(previous.rows.length, 0);

  const inserted = await a.query(
    `INSERT INTO messaggi
     (corsa_id, cliente_id, sender_id, testo,
      tipo_messaggio, client_msg_id)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING id, client_msg_id`,
    [
      corsaId,
      clienteId,
      senderId,
      "[TEST TECNICO TURENTU - TEMPORANEO]",
      "text",
      clientMsgId
    ]
  );

  assert.equal(inserted.rows.length, 1);
  firstId = inserted.rows[0].id;

  console.log("OK: primo inserimento", firstId);

  // SECONDA RICHIESTA CONCORRENTE
  await b.query("BEGIN");
  bOpen = true;

  let secondLockAcquired = false;

  const waiting = b.query(lockSql, [clientMsgId]).then(() => {
    secondLockAcquired = true;
  });

  await new Promise(resolve => setTimeout(resolve, 500));

  assert.equal(
    secondLockAcquired,
    false,
    "La seconda richiesta non è stata bloccata"
  );

  console.log("OK: seconda richiesta bloccata");

  // La prima transazione conferma
  await a.query("COMMIT");
  aOpen = false;

  await waiting;

  console.log("OK: seconda richiesta ha acquisito il lock");

  // RETRY IDEMPOTENTE
  const replay = await b.query(
    `SELECT id, corsa_id, cliente_id, sender_id
     FROM messaggi WHERE client_msg_id=$1`,
    [clientMsgId]
  );

  assert.equal(replay.rows.length, 1);
  assert.equal(replay.rows[0].id, firstId);
  assert.equal(Number(replay.rows[0].corsa_id), corsaId);
  assert.equal(Number(replay.rows[0].cliente_id), clienteId);
  assert.equal(Number(replay.rows[0].sender_id), senderId);

  console.log("OK: retry restituisce il messaggio originale");

  await b.query("COMMIT");
  bOpen = false;

  // CONTEGGIO FINALE
  const count = await pool.query(
    "SELECT COUNT(*)::int AS total FROM messaggi WHERE client_msg_id=$1",
    [clientMsgId]
  );

  assert.equal(count.rows[0].total, 1);

  console.log("OK: un solo record PostgreSQL");
  console.log("ID messaggio:", firstId);
  console.log("RISULTATO: TEST SUPERATO");

} catch (error) {
  console.error("TEST FALLITO:", error);
  process.exitCode = 1;

} finally {
  if (aOpen && a) {
    try { await a.query("ROLLBACK"); } catch {}
  }

  if (bOpen && b) {
    try { await b.query("ROLLBACK"); } catch {}
  }

  if (a) a.release();
  if (b) b.release();

  // Elimina esclusivamente il record creato dal test
  if (firstId !== null) {
    try {
      const deleted = await pool.query(
        `DELETE FROM messaggi
         WHERE id=$1 AND client_msg_id=$2
         RETURNING id`,
        [firstId, clientMsgId]
      );

      assert.equal(deleted.rows.length, 1);

      console.log("OK: record temporaneo eliminato");

    } catch (cleanupError) {
      console.error(
        "ATTENZIONE: pulizia record non riuscita:",
        cleanupError.message
      );
      process.exitCode = 1;
    }
  }

  await pool.end();
}
