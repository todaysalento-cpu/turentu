import express from "express";
import { pool } from "../db/db.js";
import jwt from "jsonwebtoken";

const chatRouter = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "segreto-di-test";

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
      WHERE ${role === "autista" ? "ct.driver_id = $1" : "ct.cliente_id = $1"}
      ORDER BY ct.updated_at DESC
    `;

    const { rows } = await pool.query(query, [userId]);
    
    // LOG DI DEBUG: Vedi cosa arriva dal DB
    log("INIT_DEBUG", { firstRow: rows[0] });

    const threads = rows.map((t) => ({
      id: `${t.corsa_id}_${t.cliente_id}`,
      corsa_id: Number(t.corsa_id),
      cliente_id: Number(t.cliente_id),
      driver_id: Number(t.driver_id),
      origine_address: t.origine_address ?? "N/D",
      destinazione_address: t.destinazione_address ?? "N/D",
      start_datetime: t.start_datetime ? new Date(t.start_datetime).toISOString() : null,
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

/* ================= MESSAGES ================= */
chatRouter.get("/messages", authMiddleware, async (req, res) => {
  const corsa_id = Number(req.query.corsa_id);
  const cliente_id = Number(req.query.cliente_id);
  const userId = Number(req.user.id);

  if (!corsa_id || !cliente_id) return res.status(400).json({ message: "missing params" });

  try {
    const threadId = `${corsa_id}_${cliente_id}`;
    const { rows } = await pool.query(
      `SELECT m.id, m.corsa_id, m.cliente_id, m.sender_id, m.testo, 
              EXTRACT(EPOCH FROM m.created_at) * 1000 as created_at_ms,
              MAX(mr.read_at) as read_at, MAX(mr.delivered_at) as delivered_at
       FROM messaggi m
       LEFT JOIN message_receipts mr ON mr.message_id = m.id AND mr.user_id = $3
       WHERE m.corsa_id = $1 AND m.cliente_id = $2
       GROUP BY m.id
       ORDER BY m.created_at DESC`, 
      [corsa_id, cliente_id, userId]
    );

    // LOG DI DEBUG: Vedi quanti messaggi stai inviando
    log("MESSAGES_DEBUG", { threadId, count: rows.length });

    const messages = rows.map((m) => ({
      id: String(m.id),
      threadId,
      sender_id: Number(m.sender_id),
      text: m.testo ?? "",
      created_at: Number(m.created_at_ms),
      status: {
        sent: true,
        delivered: Boolean(m.delivered_at) || Boolean(m.read_at),
        read: Boolean(m.read_at),
      },
    }));

    return res.json(messages);
  } catch (err) {
    log("MESSAGES_FAILED", { error: err.message });
    return res.status(500).json({ message: "messages error" });
  }
});

/* ================= MARK THREAD AS READ ================= */
chatRouter.post("/messages/read", authMiddleware, async (req, res) => {
  const { corsa_id, cliente_id } = req.body;
  const userId = Number(req.user.id);
  const role = req.user.role;

  if (!corsa_id || !cliente_id) return res.status(400).json({ message: "missing params" });

  try {
    const { rows } = await pool.query(
      `INSERT INTO message_receipts (message_id, user_id, device_id, read_at, delivered_at)
       SELECT m.id, $3, 'api', NOW(), NOW()
       FROM messaggi m
       WHERE m.corsa_id = $1 AND m.cliente_id = $2 AND m.sender_id != $3
       ON CONFLICT (message_id, user_id, device_id) 
       DO UPDATE SET read_at = COALESCE(message_receipts.read_at, NOW()), 
                     delivered_at = COALESCE(message_receipts.delivered_at, NOW())
       WHERE message_receipts.read_at IS NULL
       RETURNING message_id`,
      [corsa_id, cliente_id, userId]
    );

    if (rows.length > 0) {
      log("MESSAGES_READ", { count: rows.length });
      
      const { getIO } = await import("../socket.js");
      const io = getIO();
      const threadRes = await pool.query(
        `SELECT driver_id FROM chat_threads WHERE corsa_id = $1 AND cliente_id = $2`,
        [corsa_id, cliente_id]
      );
      const thread = threadRes.rows[0];
      if (thread) {
        const recipientId = role === "cliente" ? thread.driver_id : cliente_id;
        const targetRole = role === "cliente" ? "autista" : "cliente";
        
        io.to(`chat_${corsa_id}_${cliente_id}`)
          .to(`${targetRole}_${recipientId}`)
          .emit("message_read", { 
            corsa_id, 
            cliente_id, 
            message_ids: rows.map(r => String(r.message_id)) 
          });
      }
    }
    return res.json({ success: true, marked_ids: rows.map(r => String(r.message_id)) });
  } catch (err) {
    log("MARK_AS_READ_FAILED", { error: err.message });
    return res.status(500).json({ message: "error" });
  }
});

export default chatRouter;