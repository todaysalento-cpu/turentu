// ======================= routes/chat.routes.js =======================
import express from "express";
import { requireChatAccess } from "../services/chat/chat-auth.middleware.js";
import multer from "multer";
import { pool } from "../db/db.js";
import jwt from "jsonwebtoken";
import { cloudinary } from "../services/cloudinary.js";
import streamifier from "streamifier";
import { notifyUser } from "../services/notifications/notification.service.js";

const chatRouter = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "segreto-di-test";

const upload = multer({ storage: multer.memoryStorage() });

/* ================= LOGGER ================= */
const log = (label, data = {}) => {
  console.log(JSON.stringify({ time: new Date().toISOString(), label, ...data }, null, 2));
};

/* ================= AUTH ================= */
const authMiddleware = (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(" ")[1] || req.cookies?.token;
    if (!token) {
      log("AUTH_ERROR", { error: "No token provided" });
      return res.status(401).json({ message: "No token" });
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    decoded.role = decoded.role?.toLowerCase();

    req.user = decoded;
    log("AUTH_SUCCESS", { userId: decoded.id, role: decoded.role });
    next();
  } catch (err) {
    log("AUTH_ERROR", { error: err.message });
    return res.status(401).json({ message: "Invalid token" });
  }
};

/* ================= HELPER ================= */
async function getDriverIdByCorsa(corsa_id) {
  try {
    const { rows } = await pool.query(
      `SELECT v.driver_id FROM corse c JOIN veicolo v ON c.veicolo_id = v.id WHERE c.id = $1`,
      [Number(corsa_id)]
    );
    const driverId = rows[0]?.driver_id ? Number(rows[0].driver_id) : null;
    log("GET_DRIVER_ID_SUCCESS", { corsa_id, driverId });
    return driverId;
  } catch (err) {
    log("DB_QUERY_ERROR_DRIVER_ID", { corsa_id, error: err.message });
    return null;
  }
}

/* ================= INIT THREADS ================= */
chatRouter.get("/init", authMiddleware, async (req, res) => {
  const userId = Number(req.user.id);
  const role = req.user.role;
  log("INIT_REQUEST_RECEIVED", { userId, role });

  try {
    const query = `
      SELECT ct.*, 
             u.nome as nome_cliente,
             c.origine_address,
             c.destinazione_address,
             c.start_datetime,
             EXTRACT(EPOCH FROM ct.updated_at) * 1000 as updated_at_ms,
             (SELECT m.testo FROM messaggi m 
              WHERE m.corsa_id = ct.corsa_id AND m.cliente_id = ct.cliente_id 
              ORDER BY m.created_at DESC LIMIT 1) as last_text,
             (SELECT EXTRACT(EPOCH FROM m.created_at) * 1000 FROM messaggi m 
              WHERE m.corsa_id = ct.corsa_id AND m.cliente_id = ct.cliente_id 
              ORDER BY m.created_at DESC LIMIT 1) as last_time_ms,
             COALESCE(
              (SELECT COUNT(m.id)::int 
               FROM messaggi m
               WHERE m.corsa_id = ct.corsa_id 
                 AND m.cliente_id = ct.cliente_id 
                 AND m.sender_id != $1
                 AND NOT EXISTS (
                   SELECT 1 FROM message_receipts mr 
                   WHERE mr.message_id = m.id 
                     AND mr.user_id = $1 
                     AND mr.read_at IS NOT NULL
                 )
              ), 0) as unread_count
      FROM chat_threads ct
      JOIN utente u ON ct.cliente_id = u.id
      JOIN corse c ON ct.corsa_id = c.id
      WHERE ${role === "autista" ? "ct.driver_id = $1" : "ct.cliente_id = $1"}
      ORDER BY ct.updated_at DESC
    `;

    const { rows } = await pool.query(query, [userId]);
    log("INIT_DB_SUCCESS", { count: rows.length, sample: rows[0] || null });

    const threads = rows.map((t) => ({
      id: `${t.corsa_id}_${t.cliente_id}`,
      corsa_id: Number(t.corsa_id),
      cliente_id: Number(t.cliente_id),
      nome_cliente: t.nome_cliente ?? "Cliente",
      origine: t.origine_address && t.origine_address.trim() !== "" ? t.origine_address : "Indirizzo origine non specificato",
      destinazione: t.destinazione_address && t.destinazione_address.trim() !== "" ? t.destinazione_address : "Indirizzo destinazione non specificato",
      start_datetime: t.start_datetime ?? null,
      unreadCount: Number(t.unread_count ?? 0),
      lastMessage: t.last_text ?? "Nessun messaggio",
      updated_at: Number(t.last_time_ms ?? t.updated_at_ms),
    }));

    return res.json(threads);
  } catch (err) {
    log("INIT_THREADS_FAILED", { error: err.message });
    return res.status(500).json({ message: "init error" });
  }
});

/* ================= GET MESSAGES ================= */
chatRouter.get("/messages", authMiddleware, requireChatAccess, async (req, res) => {
  const { corsa_id, cliente_id } = req.query;
  log("GET_MESSAGES_RECEIVED", { corsa_id, cliente_id });

  if (!corsa_id || !cliente_id) {
    log("GET_MESSAGES_MISSING_PARAMS", { corsa_id, cliente_id });
    return res.status(400).json({ message: "missing params" });
  }

  try {
    const { rows } = await pool.query(
      `
      SELECT m.id, m.corsa_id, m.cliente_id, m.client_msg_id, m.sender_id, m.testo, m.audio_url, m.media_url, m.tipo_messaggio, m.duration,
             EXTRACT(EPOCH FROM m.created_at) * 1000 as created_at_ms,
              EXISTS (SELECT 1 FROM message_receipts mr WHERE mr.message_id = m.id AND mr.user_id <> m.sender_id AND (mr.delivered_at IS NOT NULL OR mr.read_at IS NOT NULL)) as is_delivered,
             EXISTS (SELECT 1 FROM message_receipts mr WHERE mr.message_id = m.id AND mr.user_id <> m.sender_id AND mr.read_at IS NOT NULL) as is_read
      FROM messaggi m
      WHERE m.corsa_id = $1 AND m.cliente_id = $2
      ORDER BY m.created_at ASC
      `,
      [Number(corsa_id), Number(cliente_id)]
    );

    const messages = rows.map((m) => ({
      id: String(m.id),
      corsa_id: Number(m.corsa_id),
      cliente_id: Number(m.cliente_id),
      client_msg_id: m.client_msg_id ?? null,
      sender_id: Number(m.sender_id),
      text: m.testo ?? "",
      audio_url: m.audio_url ?? null,
      media_url: m.media_url ?? null,
      tipo_messaggio: m.tipo_messaggio ?? "text",
      duration: Number(m.duration ?? 0),
      created_at: Number(m.created_at_ms),
      status: { sent: true, delivered: Boolean(m.is_delivered), read: Boolean(m.is_read) },
    }));

    log("GET_MESSAGES_SUCCESS", { count: messages.length });
    return res.json(messages);
  } catch (err) {
    log("GET_MESSAGES_FAILED", { error: err.message });
    return res.status(500).json({ message: "messages error" });
  }
});

/* ================= MEDIA MESSAGE ================= */
chatRouter.post("/messages/media", authMiddleware, upload.single("audio"), requireChatAccess, async (req, res) => {
  const { client_msg_id, tipo_messaggio, text, lat, lng, audio_base64, media_base64 } = req.body;
  const corsa_id = Number(req.body.corsa_id);
  const cliente_id = Number(req.body.cliente_id);
  const duration = parseFloat(req.body.duration) || 0;
  const sender_id = Number(req.user.id);
  const sender_role = req.user.role;

  // MEDIA_IDEMPOTENCY_V1
  const clientMsgId = String(client_msg_id || "").trim();

  if (
    !clientMsgId ||
    clientMsgId.length > 200 ||
    !Number.isSafeInteger(corsa_id) || corsa_id <= 0 ||
    !Number.isSafeInteger(cliente_id) || cliente_id <= 0 ||
    !Number.isSafeInteger(sender_id) || sender_id <= 0
  ) {
    return res.status(400).json({ message: "Dati messaggio non validi" });
  }

  let dbClient = null;
  let transactionOpen = false;

  try {
    dbClient = await pool.connect();

    await dbClient.query("BEGIN");
    transactionOpen = true;

    // Serializza le richieste con lo stesso identificativo.
    await dbClient.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [clientMsgId]
    );

    // Retry: restituisce il messaggio originale senza nuovo upload.
    const existingResult = await dbClient.query(
      "SELECT *, EXTRACT(EPOCH FROM created_at) * 1000 AS created_at_ms FROM messaggi WHERE client_msg_id = $1 LIMIT 1",
      [clientMsgId]
    );

    if (existingResult.rows.length) {
      const existing = existingResult.rows[0];

      const sameOwner =
        Number(existing.corsa_id) === corsa_id &&
        Number(existing.cliente_id) === cliente_id &&
        Number(existing.sender_id) === sender_id;

      await dbClient.query("COMMIT");
      transactionOpen = false;

      if (!sameOwner) {
        log("MEDIA_IDEMPOTENCY_CONFLICT", {
          sender_id,
          client_msg_id: clientMsgId
        });
        return res.status(409).json({
          message: "Identificativo messaggio gia utilizzato"
        });
      }

      log("MEDIA_IDEMPOTENCY_REPLAY", {
        messageId: existing.id,
        sender_id
      });

      return res.json({
        ...existing,
        duration: Number(existing.duration || 0)
      });
    }

    let mediaUrl = null;
    let audioUrl = null;
    let content = text || (tipo_messaggio === "audio" ? "Audio" : null);

    const uploadToCloudinary = (buffer) =>
      new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          { resource_type: "auto" },
          (err, result) =>
            err ? reject(err) : resolve(result.secure_url)
        );

        streamifier.createReadStream(buffer).pipe(stream);
      });

    if (req.file) {
      log("CLOUDINARY_UPLOAD_MULTER", {
        size: req.file.buffer.length
      });

      const secureUrl = await uploadToCloudinary(req.file.buffer);

      if (tipo_messaggio === "audio") {
        audioUrl = secureUrl;
      } else {
        mediaUrl = secureUrl;
      }
    } else if (tipo_messaggio === "audio" && audio_base64) {
      const base64Data = audio_base64.replace(
        /^data:audio\/\w+;base64,/,
        ""
      );

      audioUrl = await uploadToCloudinary(
        Buffer.from(base64Data, "base64")
      );
    } else if (tipo_messaggio !== "audio" && media_base64) {
      const base64Data = media_base64.replace(
        /^data:\w+\/\w+;base64,/,
        ""
      );

      mediaUrl = await uploadToCloudinary(
        Buffer.from(base64Data, "base64")
      );
    }

    if (tipo_messaggio === "location") {
      content = JSON.stringify({ lat, lng });
    }

    const insertResult = await dbClient.query(
      "INSERT INTO messaggi (corsa_id, cliente_id, sender_id, tipo_messaggio, testo, media_url, audio_url, client_msg_id, duration) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (client_msg_id) DO NOTHING RETURNING *, EXTRACT(EPOCH FROM created_at) * 1000 AS created_at_ms",
      [
        corsa_id,
        cliente_id,
        sender_id,
        tipo_messaggio,
        content,
        mediaUrl,
        audioUrl,
        clientMsgId,
        duration
      ]
    );

    if (!insertResult.rows.length) {
      // Protezione aggiuntiva contro conflitti esterni.
      const conflictResult = await dbClient.query(
        "SELECT * FROM messaggi WHERE client_msg_id = $1 LIMIT 1",
        [clientMsgId]
      );

      await dbClient.query("COMMIT");
      transactionOpen = false;

      const existing = conflictResult.rows[0];

      if (
        !existing ||
        Number(existing.corsa_id) !== corsa_id ||
        Number(existing.cliente_id) !== cliente_id ||
        Number(existing.sender_id) !== sender_id
      ) {
        return res.status(409).json({
          message: "Conflitto identificativo messaggio"
        });
      }

      return res.json({
        ...existing,
        duration: Number(existing.duration || 0)
      });
    }

    const msg = insertResult.rows[0];
    const formattedDuration = Number(msg.duration || 0);

    const socketMessage = {
      id: msg.id,
      sender_id: Number(msg.sender_id),
      text: msg.testo ?? "",
      audio_url: msg.audio_url ?? null,
      media_url: msg.media_url ?? null,
      tipo_messaggio: msg.tipo_messaggio,
      duration: formattedDuration,
      corsa_id: Number(msg.corsa_id),
      cliente_id: Number(msg.cliente_id),
      created_at: Number(msg.created_at_ms || Date.now()),
      client_msg_id: msg.client_msg_id
    };

    await dbClient.query("COMMIT");
    transactionOpen = false;

    // Le notifiche non devono trasformare un salvataggio riuscito in HTTP 500.
    try {
      const { getIO } = await import("../socket.js");

      getIO()
        .to("chat_" + corsa_id + "_" + cliente_id)
        .emit("new_message", socketMessage);

      log("SOCKET_MESSAGE_EMITTED", { msgId: msg.id });
    } catch (socketErr) {
      log("MEDIA_SOCKET_NOTIFY_FAILED", {
        error: socketErr.message,
        msgId: msg.id
      });
    }

    try {
      const recipientId =
        sender_role === "autista"
          ? cliente_id
          : await getDriverIdByCorsa(corsa_id);

      if (recipientId) {
        await notifyUser(recipientId, {
          type: "chat",
          message:
            tipo_messaggio === "text"
              ? text || "Nuovo messaggio"
              : "Hai ricevuto un file",
          role: sender_role === "autista" ? "cliente" : "autista",
          data: { corsa_id, cliente_id }
        });
      }
    } catch (fcmErr) {
      log("FCM_NOTIFICATION_FAILED", {
        error: fcmErr.message,
        msgId: msg.id
      });
    }

    return res.json({
      ...msg,
      duration: formattedDuration
    });

  } catch (err) {
    if (dbClient && transactionOpen) {
      try {
        await dbClient.query("ROLLBACK");
      } catch (rollbackErr) {
        log("MEDIA_ROLLBACK_FAILED", {
          error: rollbackErr.message
        });
      }
    }

    log("UPLOAD_MEDIA_FAILED", { error: err.message });

    return res.status(500).json({
      message: "Errore invio"
    });
  } finally {
    if (dbClient) dbClient.release();
  }
});

/* ================= MARK AS READ ================= */
chatRouter.post("/messages/read", authMiddleware, requireChatAccess, async (req, res) => {
  const { corsa_id, cliente_id } = req.body;
  const userId = Number(req.user.id);
  log("MARK_READ_REQUEST", { corsa_id, cliente_id, userId });

  try {
    const { rows: readRows } = await pool.query(
      `INSERT INTO message_receipts (message_id, user_id, read_at)
       SELECT m.id, $3, NOW()
       FROM messaggi m
       WHERE m.corsa_id = $1 AND m.cliente_id = $2 AND m.sender_id != $3
       ON CONFLICT (message_id, user_id) DO UPDATE SET read_at = COALESCE(message_receipts.read_at, EXCLUDED.read_at) RETURNING message_id`,
      [Number(corsa_id), Number(cliente_id), userId]
    );
    if (readRows.length) {
      try {
        const { getIO } = await import("../socket.js");
        getIO().to(`chat_${Number(corsa_id)}_${Number(cliente_id)}`).emit("message_read", {
          corsa_id: Number(corsa_id), cliente_id: Number(cliente_id),
          message_ids: readRows.map(r => String(r.message_id))
        });
      } catch (notifyErr) {
        log("MARK_READ_NOTIFY_FAILED", { error: notifyErr.message });
      }
    }
    log("MARK_READ_SUCCESS", { userId });
    return res.json({ success: true });
  } catch (err) {
    log("MARK_READ_FAILED", { error: err.message });
    return res.status(500).json({ message: "error" });
  }
});

export default chatRouter;