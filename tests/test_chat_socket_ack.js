
import test from "node:test";
import assert from "node:assert/strict";
import { pool } from "../db/db.js";
import { setupSocket } from "../socket.js";

test("Socket.IO ACK: invio, retry idempotente e protezione identificativo", async () => {
  const originalQuery = pool.query;
  const handlers = {};
  const emitted = [];
  const stored = new Map();
  let nextId = 1000;
  let inserts = 0;

  try {
    pool.query = async (sql, params) => {
      if (sql.includes("SELECT 1 FROM chat_threads")) {
        return {
          rows: [101, 5].includes(Number(params[2])) ? [{ ok: 1 }] : []
        };
      }

      if (sql.includes("INSERT INTO messaggi")) {
        inserts++;

        const [cId, clId, senderId, text, audio, type, clientId] = params;

        if (stored.has(clientId)) {
          return { rows: [] };
        }

        const message = {
          id: ++nextId,
          corsa_id: cId,
          cliente_id: clId,
          sender_id: senderId,
          testo: text,
          audio_url: audio,
          tipo_messaggio: type,
          client_msg_id: clientId,
          created_at_ms: Date.now()
        };

        stored.set(clientId, message);
        return { rows: [message] };
      }

      if (sql.includes("WHERE client_msg_id = $1")) {
        const m = stored.get(params[0]);

        return {
          rows: m &&
            m.corsa_id === params[1] &&
            m.cliente_id === params[2] &&
            m.sender_id === params[3]
              ? [m]
              : []
        };
      }

      if (sql.includes("SELECT driver_id FROM chat_threads")) {
        return { rows: [{ driver_id: 5 }] };
      }

      throw Error("Query imprevista: " + sql);
    };

    const io = {
      use: () => {},
      on: (event, callback) => {
        handlers[event] = callback;
      },
      to: (room) => ({
        emit: (event, data) => emitted.push({ room, event, data })
      })
    };

    setupSocket(io);

    async function createUser(userId) {
      const events = {};

      const socket = {
        id: "test-" + userId,
        user: {
          id: userId,
          role: userId === 101 ? "cliente" : "autista"
        },
        join: () => {},
        on: (event, callback) => {
          events[event] = callback;
        }
      };

      handlers.connection(socket);

      return {
        events,
        send: async (payload) => {
          let resolveAck;

          const ackPromise = new Promise(resolve => {
            resolveAck = resolve;
          });

          const handlerPromise = events.send_message(
            payload,
            resolveAck
          );

          const [ack] = await Promise.all([
            ackPromise,
            handlerPromise
          ]);

          return ack;
        }
      };
    }

    const cliente = await createUser(101);

    const payload = {
      corsa_id: 42,
      cliente_id: 101,
      text: "Test ACK",
      tipo_messaggio: "text",
      client_msg_id: "ack-test-001"
    };

    // Primo invio
    const first = await cliente.send(payload);

    assert.equal(first.ok, true);
    assert.equal(first.duplicate, false);
    assert.ok(first.message.id);

    // Retry dello stesso messaggio
    const retry = await cliente.send(payload);

    assert.equal(retry.ok, true);
    assert.equal(retry.duplicate, true);
    assert.equal(retry.message.id, first.message.id);

    // Altro utente: riutilizzo identificativo vietato
    const autista = await createUser(5);
    const conflict = await autista.send(payload);

    assert.equal(conflict.ok, false);
    assert.equal(conflict.error, "MESSAGE_ID_CONFLICT");

    // Utente estraneo
    const estraneo = await createUser(999);
    const denied = await estraneo.send(payload);

    assert.equal(denied.ok, false);
    assert.equal(denied.error, "CHAT_ACCESS_DENIED");

    // Un solo messaggio effettivamente creato
    assert.equal(stored.size, 1);
    assert.equal(inserts, 3);

    // Un solo evento e una sola notifica
    assert.equal(
      emitted.filter(x => x.event === "new_message").length,
      1
    );

    assert.equal(
      emitted.filter(x => x.event === "unread_count_updated").length,
      1
    );

    console.log("OK: ACK, retry, conflitto e sicurezza verificati");

  } finally {
    pool.query = originalQuery;
  }
});
