// ======================= routes/chat.routes.js =======================
import express from "express";
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
      WHERE ${role === "autista" ? "ct.driver_id = $1" : "ct.cliente_id = $1"}
      ORDER BY ct.updated_at DESC
    `;

    const { rows } = await pool.query(query, [userId]);
    log("INIT_DB_SUCCESS", { count: rows.length });

    const threads = rows.map((t) => ({
      id: `${t.corsa_id}_${t.cliente_id}`,
      corsa_id: Number(t.corsa_id),
      cliente_id: Number(t.cliente_id),
      nome_cliente: t.nome_cliente ?? "Cliente",
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
chatRouter.get("/messages", authMiddleware, async (req, res) => {
  const { corsa_id, cliente_id } = req.query;
  log("GET_MESSAGES_RECEIVED", { corsa_id, cliente_id });

  if (!corsa_id || !cliente_id) {
    log("GET_MESSAGES_MISSING_PARAMS", { corsa_id, cliente_id });
    return res.status(400).json({ message: "missing params" });
  }

  try {
    const { rows } = await pool.query(
      `
      SELECT m.id, m.sender_id, m.testo, m.audio_url, m.media_url, m.tipo_messaggio,
             EXTRACT(EPOCH FROM m.created_at) * 1000 as created_at_ms,
             EXISTS (SELECT 1 FROM message_receipts mr WHERE mr.message_id = m.id) as is_read
      FROM messaggi m
      WHERE m.corsa_id = $1 AND m.cliente_id = $2
      ORDER BY m.created_at ASC
      `,
      [Number(corsa_id), Number(cliente_id)]
    );

    const messages = rows.map((m) => ({
      id: String(m.id),
      sender_id: Number(m.sender_id),
      text: m.testo ?? "",
      audio_url: m.audio_url ?? null,
      media_url: m.media_url ?? null,
      tipo_messaggio: m.tipo_messaggio ?? "text",
      created_at: Number(m.created_at_ms),
      status: { sent: true, read: Boolean(m.is_read) },
    }));

    log("GET_MESSAGES_SUCCESS", { count: messages.length });
    return res.json(messages);
  } catch (err) {
    log("GET_MESSAGES_FAILED", { error: err.message });
    return res.status(500).json({ message: "messages error" });
  }
});

/* ================= MEDIA MESSAGE ================= */
chatRouter.post("/messages/media", authMiddleware, upload.single("audio"), async (req, res) => {
  const { client_msg_id, tipo_messaggio, text, lat, lng, audio_base64, media_base64 } = req.body;
  const corsa_id = Number(req.body.corsa_id);
  const cliente_id = Number(req.body.cliente_id);
  const sender_id = Number(req.user.id);
  const sender_role = req.user.role;

  log("MEDIA_UPLOAD_STARTED", { sender_id, sender_role, tipo_messaggio, corsa_id, cliente_id });

  try {
    let mediaUrl = null;
    let audioUrl = null;
    let content = text || (tipo_messaggio === "audio" ? "Audio" : null);

    const uploadToCloudinary = (buffer) =>
      new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          { resource_type: "auto" },
          (err, result) => (err ? reject(err) : resolve(result.secure_url))
        );
        streamifier.createReadStream(buffer).pipe(stream);
      });

    // 1. Gestione file binario via Multer (multipart/form-data)
    if (req.file) {
      log("CLOUDINARY_UPLOAD_MULTER", { size: req.file.buffer.length });
      const secureUrl = await uploadToCloudinary(req.file.buffer);
      if (tipo_messaggio === "audio") {
        audioUrl = secureUrl;
      } else {
        mediaUrl = secureUrl;
      }
    } 
    // 2. Gestione stringa Base64 inviata tramite JSON body
    else if (tipo_messaggio === "audio" && audio_base64) {
      log("CLOUDINARY_UPLOAD_BASE64_AUDIO");
      const base64Data = audio_base64.replace(/^data:audio\/\w+;base64,/, "");
      const buffer = Buffer.from(base64Data, 'base64');
      audioUrl = await uploadToCloudinary(buffer);
    } else if (tipo_messaggio !== "audio" && media_base64) {
      log("CLOUDINARY_UPLOAD_BASE64_MEDIA");
      const base64Data = media_base64.replace(/^data:\w+\/\w+;base64,/, "");
      const buffer = Buffer.from(base64Data, 'base64');
      mediaUrl = await uploadToCloudinary(buffer);
    }

    log("MEDIA_UPLOAD_CLOUDINARY_SUCCESS", { audioUrl, mediaUrl });

    if (tipo_messaggio === "location") content = JSON.stringify({ lat, lng });

    const { rows } = await pool.query(
      `INSERT INTO messaggi (corsa_id, cliente_id, sender_id, tipo_messaggio, testo, media_url, audio_url, client_msg_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [corsa_id, cliente_id, sender_id, tipo_messaggio, content, mediaUrl, audioUrl, client_msg_id]
    );

    const msg = rows[0];
    const socketMessage = {
      id: msg.id,
      sender_id: Number(msg.sender_id),
      text: msg.testo ?? "",
      audio_url: msg.audio_url ?? null,
      media_url: msg.media_url ?? null,
      tipo_messaggio: msg.tipo_messaggio,
      corsa_id: Number(msg.corsa_id),
      cliente_id: Number(msg.cliente_id),
      created_at: Date.now(),
      client_msg_id: msg.client_msg_id ?? null,
    };

    const { getIO } = await import("../socket.js");
    getIO().emit("new_message", socketMessage);
    log("SOCKET_MESSAGE_EMITTED", { msgId: msg.id });

    const recipientId = sender_role === "autista" ? cliente_id : await getDriverIdByCorsa(corsa_id);
    
    if (recipientId) {
      try {
        await notifyUser(recipientId, {
          type: "chat",
          message: tipo_messaggio === "text" ? text || "Nuovo messaggio" : "Hai ricevuto un file",
          role: sender_role === "autista" ? "cliente" : "autista",
          data: { corsa_id, cliente_id },
        });
        log("FCM_NOTIFICATION_SUCCESS", { recipientId });
      } catch (fcmErr) {
        log("FCM_NOTIFICATION_FAILED", { error: fcmErr.message });
      }
    } else {
      log("FCM_NOTIFICATION_SKIPPED", { reason: "Recipient ID not found" });
    }

    return res.json(msg);
  } catch (err) {
    log("UPLOAD_MEDIA_FAILED", { error: err.message });
    return res.status(500).json({ message: "Errore invio" });
  }
});

/* ================= MARK AS READ ================= */
chatRouter.post("/messages/read", authMiddleware, async (req, res) => {
  const { corsa_id, cliente_id } = req.body;
  const userId = Number(req.user.id);
  log("MARK_READ_REQUEST", { corsa_id, cliente_id, userId });

  try {
    await pool.query(
      `INSERT INTO message_receipts (message_id, user_id, read_at)
       SELECT m.id, $3, NOW()
       FROM messaggi m
       WHERE m.corsa_id = $1 AND m.cliente_id = $2 AND m.sender_id != $3
       ON CONFLICT DO NOTHING`,
      [Number(corsa_id), Number(cliente_id), userId]
    );
    log("MARK_READ_SUCCESS", { userId });
    return res.json({ success: true });
  } catch (err) {
    log("MARK_READ_FAILED", { error: err.message });
    return res.status(500).json({ message: "error" });
  }
});

export default chatRouter;