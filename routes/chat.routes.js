import express from "express";
import multer from "multer";
import { pool } from "../db/db.js";
import jwt from "jsonwebtoken";
// IMPORTANTE: Usa le parentesi graffe qui sotto
import { cloudinary } from "../../services/cloudinary.js"; 
import streamifier from "streamifier";

const chatRouter = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "segreto-di-test";

// Configurazione storage in memoria
const upload = multer({ storage: multer.memoryStorage() });

/* ================= LOGGER ================= */
const log = (label, data = {}) => {
  console.log(JSON.stringify({ time: new Date().toISOString(), label, ...data }, null, 2));
};

/* ================= AUTH ================= */
const authMiddleware = (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(" ")[1] || req.cookies?.token;
    if (!token) return res.status(401).json({ message: "No token" });
    const decoded = jwt.verify(token, JWT_SECRET);
    decoded.role = decoded.role?.toLowerCase();
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ message: "Invalid token" });
  }
};

/* ================= INIT THREADS ================= */
chatRouter.get("/init", authMiddleware, async (req, res) => {
  const userId = Number(req.user.id);
  const role = req.user.role;

  try {
    const query = `
      SELECT ct.*, 
             c.origine_address, c.destinazione_address, c.start_datetime,
             u.nome as nome_cliente,
             EXTRACT(EPOCH FROM ct.updated_at) * 1000 as updated_at_ms,
             (SELECT m.testo FROM messaggi m 
              WHERE m.corsa_id = ct.corsa_id AND m.cliente_id = ct.cliente_id 
              ORDER BY m.created_at DESC LIMIT 1) as last_text,
             (SELECT EXTRACT(EPOCH FROM m.created_at) * 1000 FROM messaggi m 
              WHERE m.corsa_id = ct.corsa_id AND m.cliente_id = ct.cliente_id 
              ORDER BY m.created_at DESC LIMIT 1) as last_time_ms,
             COALESCE((
               SELECT COUNT(m.id)::int
               FROM messaggi m
               WHERE m.corsa_id = ct.corsa_id 
                 AND m.cliente_id = ct.cliente_id 
                 AND m.sender_id != $1
                 AND NOT EXISTS (
                   SELECT 1 FROM message_receipts mr 
                   WHERE mr.message_id = m.id AND mr.user_id = $1 AND mr.read_at IS NOT NULL
                 )
             ), 0) as unread_count
      FROM chat_threads ct
      JOIN corse c ON ct.corsa_id = c.id
      JOIN utente u ON ct.cliente_id = u.id
      WHERE ${role === "autista" ? "ct.driver_id = $1" : "ct.cliente_id = $1"}
      ORDER BY ct.updated_at DESC
    `;

    const { rows } = await pool.query(query, [userId]);
    
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
  const corsa_id = Number(req.query.corsa_id);
  const cliente_id = Number(req.query.cliente_id);

  if (!corsa_id || !cliente_id) return res.status(400).json({ message: "missing params" });

  try {
    const { rows } = await pool.query(
      `SELECT m.id, m.sender_id, m.testo, m.audio_url, m.tipo_messaggio, 
              EXTRACT(EPOCH FROM m.created_at) * 1000 as created_at_ms,
              (MAX(mr.read_at) IS NOT NULL) as is_read,
              (MAX(mr.delivered_at) IS NOT NULL) as is_delivered
       FROM messaggi m
       LEFT JOIN message_receipts mr ON m.id = mr.message_id
       WHERE m.corsa_id = $1 AND m.cliente_id = $2
       GROUP BY m.id, m.sender_id, m.testo, m.audio_url, m.tipo_messaggio, m.created_at
       ORDER BY m.created_at DESC`, 
      [corsa_id, cliente_id]
    );

    const messages = rows.map((m) => ({
      id: String(m.id),
      sender_id: Number(m.sender_id),
      text: m.testo ?? null,
      audio_url: m.audio_url ?? null,
      tipo_messaggio: m.tipo_messaggio ?? 'text',
      created_at: Number(m.created_at_ms),
      status: { sent: true, delivered: Boolean(m.is_delivered), read: Boolean(m.is_read) },
    }));

    return res.json(messages);
  } catch (err) {
    log("MESSAGES_FAILED", { error: err.message });
    return res.status(500).json({ message: "messages error" });
  }
});

/* ================= UPLOAD AUDIO (CLOUDINARY) ================= */
chatRouter.post("/messages/audio", authMiddleware, upload.single('audio'), async (req, res) => {
  const { corsa_id, cliente_id, client_msg_id } = req.body;
  const sender_id = req.user.id;
  
  if (!req.file || !corsa_id || !cliente_id || !client_msg_id) {
    return res.status(400).json({ message: "Parametri o file mancanti" });
  }

  try {
    const uploadToCloudinary = (buffer) => {
      return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          { resource_type: "video" }, 
          (error, result) => {
            if (result) resolve(result.secure_url);
            else reject(error);
          }
        );
        streamifier.createReadStream(buffer).pipe(stream);
      });
    };

    const audioUrl = await uploadToCloudinary(req.file.buffer);

    const { rows } = await pool.query(
      `INSERT INTO messaggi (corsa_id, cliente_id, sender_id, tipo_messaggio, audio_url, client_msg_id)
       VALUES ($1, $2, $3, 'audio', $4, $5) RETURNING *`,
      [corsa_id, cliente_id, sender_id, audioUrl, client_msg_id]
    );

    return res.json(rows[0]);
  } catch (err) {
    log("UPLOAD_AUDIO_FAILED", { error: err.message });
    return res.status(500).json({ message: "Errore salvataggio audio" });
  }
});

/* ================= MARK THREAD AS READ ================= */
chatRouter.post("/messages/read", authMiddleware, async (req, res) => {
  const { corsa_id, cliente_id } = req.body;
  const userId = Number(req.user.id);

  try {
    const { rows } = await pool.query(
      `INSERT INTO message_receipts (message_id, user_id, read_at, delivered_at)
       SELECT m.id, $3, NOW(), NOW()
       FROM messaggi m
       WHERE m.corsa_id = $1 AND m.cliente_id = $2 AND m.sender_id != $3
       ON CONFLICT (message_id, user_id) 
       DO UPDATE SET read_at = COALESCE(message_receipts.read_at, EXCLUDED.read_at)
       RETURNING message_id`,
      [corsa_id, cliente_id, userId]
    );

    if (rows.length > 0) {
      const { getIO } = await import("../socket.js");
      const io = getIO();
      io.emit("message_read", { corsa_id, cliente_id, message_ids: rows.map(r => String(r.message_id)) });
    }
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ message: "error" });
  }
});

export default chatRouter;