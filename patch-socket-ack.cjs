
const fs = require("fs");

const file = "socket.js";
const backup = "socket.js.bak-socket-ack";

const source = fs.readFileSync(file, "utf8");

const startMarker =
  '    socket.on("send_message", async (payload) => {';

const endMarker =
  '    socket.on("disconnect", (reason) => {';

const start = source.indexOf(startMarker);
const end = source.indexOf(endMarker, start);

if (start < 0 || end < 0 || end <= start) {
  throw new Error("STOP: handler originale non trovato");
}

if (fs.existsSync(backup)) {
  throw new Error("STOP: backup già esistente");
}

const oldBlock = source.slice(start, end);

if (
  !oldBlock.includes("INSERT INTO messaggi") ||
  !oldBlock.includes("new_message") ||
  !oldBlock.includes("unread_count_updated")
) {
  throw new Error("STOP: handler originale inatteso");
}

const replacement = `    socket.on("send_message", async (payload, ack) => {
      const reply = (data) => {
        if (typeof ack === "function") ack(data);
      };

      try {
        const cId = Number(payload?.corsa_id);
        const clId = Number(payload?.cliente_id);
        const clientMsgId = String(payload?.client_msg_id || "").trim();

        if (
          !Number.isSafeInteger(cId) || cId <= 0 ||
          !Number.isSafeInteger(clId) || clId <= 0 ||
          !clientMsgId || clientMsgId.length > 200
        ) {
          return reply({ ok: false, error: "INVALID_MESSAGE_DATA" });
        }

        if (!(await canAccessChat(pool, cId, clId, userId))) {
          log("SEND_MESSAGE_FORBIDDEN", { userId, cId, clId });
          return reply({ ok: false, error: "CHAT_ACCESS_DENIED" });
        }

        const msgRes = await pool.query(
          \`INSERT INTO messaggi
            (corsa_id, cliente_id, sender_id, testo, audio_url, tipo_messaggio, client_msg_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (client_msg_id) DO NOTHING
           RETURNING *, EXTRACT(EPOCH FROM created_at) * 1000 AS created_at_ms\`,
          [
            cId, clId, userId, payload.text,
            payload.audio_url, payload.tipo_messaggio || "text",
            clientMsgId
          ]
        );

        const inserted = msgRes.rows.length > 0;
        let message = msgRes.rows[0];

        if (!inserted) {
          const existing = await pool.query(
            \`SELECT *, EXTRACT(EPOCH FROM created_at) * 1000 AS created_at_ms
             FROM messaggi
             WHERE client_msg_id = $1
               AND corsa_id = $2
               AND cliente_id = $3
               AND sender_id = $4\`,
            [clientMsgId, cId, clId, userId]
          );

          if (!existing.rows.length) {
            return reply({ ok: false, error: "MESSAGE_ID_CONFLICT" });
          }

          message = existing.rows[0];
        }

        const socketMessage = {
          ...message,
          corsa_id: cId,
          cliente_id: clId
        };

        reply({
          ok: true,
          message: socketMessage,
          duplicate: !inserted
        });

        if (!inserted) return;

        io.to(\`chat_\${cId}_\${clId}\`)
          .emit("new_message", socketMessage);

        const threadRes = await pool.query(
          "SELECT driver_id FROM chat_threads WHERE corsa_id=$1 AND cliente_id=$2",
          [cId, clId]
        );

        const targetRole = role === "cliente" ? "autista" : "cliente";
        const recipientId =
          role === "cliente" ? threadRes.rows[0]?.driver_id : clId;

        if (recipientId) {
          io.to(\`\${targetRole}_\${Number(recipientId)}\`)
            .emit("unread_count_updated", {
              corsa_id: cId,
              cliente_id: clId,
              increment: 1
            });
        }
      } catch (err) {
        log("SEND_MESSAGE_FAILED", { userId, error: err.message });
        reply({ ok: false, error: "MESSAGE_SEND_FAILED" });
      }
    });

`;

fs.copyFileSync(file, backup);
fs.writeFileSync(
  file,
  source.slice(0, start) + replacement + source.slice(end),
  "utf8"
);

console.log("OK: ACK implementato; backup creato");
