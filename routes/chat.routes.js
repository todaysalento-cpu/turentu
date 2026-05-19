import express from "express";
import { pool } from "../db/db.js";
import jwt from "jsonwebtoken";

const chatRouter = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "segreto-di-test";

const log = (label, data = {}) => {
  console.log(JSON.stringify({ time: new Date().toISOString(), label, ...data }, null, 2));
};

const authMiddleware = (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(" ")[1] || req.cookies?.token;
    if (!token) return res.status(401).json({ message: "No token" });
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = { id: Number(decoded.id), role: decoded.role?.toLowerCase() };
    next();
  } catch (err) {
    return res.status(401).json({ message: "Invalid token" });
  }
};

/* ================= INIT THREADS (RIPRISTINATA) ================= */
chatRouter.get("/init", authMiddleware, async (req, res) => {
  const userId = req.user.id;
  const role = req.user.role;

  try {
    const query = `
      SELECT ct.corsa_id, ct.cliente_id, ct.driver_id, ct.updated_at,
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
      WHERE ${role === "autista" ? "ct.driver_id = $1" : "ct.cliente_id = $1"}
      ORDER BY ct.updated_at DESC
    `;
    const { rows } = await pool.query(query, [userId]);
    res.json(rows.map(t => ({ ...t, unreadCount: Number(t.unread_count) })));
  } catch (err) {
    log("INIT_THREADS_FAILED", { error: err.message });
    res.status(500).json({ message: "init error" });
  }
});

/* ================= MESSAGES ================= */
chatRouter.get("/messages", authMiddleware, async (req, res) => {
  const corsa_id = Number(req.query.corsa_id);
  const cliente_id = Number(req.query.cliente_id);
  const userId = req.user.id;

  if (!corsa_id || !cliente_id) return res.status(400).json({ message: "missing params" });

  try {
    log("DEBUG_MESSAGES_QUERY", { userId, corsa_id, cliente_id });

    const { rows } = await pool.query(
      `SELECT m.id, m.sender_id, m.testo, m.created_at, 
              MAX(mr.read_at) as read_at, 
              MAX(mr.delivered_at) as delivered_at
       FROM messaggi m
       LEFT JOIN message_receipts mr ON mr.message_id = m.id AND mr.user_id = $3
       WHERE m.corsa_id = $1 AND m.cliente_id = $2
       GROUP BY m.id
       ORDER BY m.created_at ASC`,
      [corsa_id, cliente_id, userId]
    );

    log("DEBUG_MESSAGES_RESULT", { total: rows.length, readCount: rows.filter(r => r.read_at).length });

    const messages = rows.map((m) => ({
      id: String(m.id),
      sender_id: Number(m.sender_id),
      text: m.testo ?? "",
      created_at: m.created_at ? Number(new Date(m.created_at)) : Date.now(),
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
  const userId = req.user.id;

  try {
    log("DEBUG_MARK_READ_ATTEMPT", { userId, corsa_id, cliente_id });

    const { rowCount } = await pool.query(
      `INSERT INTO message_receipts (message_id, user_id, device_id, read_at, delivered_at)
       SELECT m.id, $3, 'api', NOW(), NOW()
       FROM messaggi m
       WHERE m.corsa_id = $1 AND m.cliente_id = $2 AND m.sender_id != $3
       ON CONFLICT (message_id, user_id, device_id) 
       DO UPDATE SET read_at = COALESCE(message_receipts.read_at, NOW()), 
                     delivered_at = COALESCE(message_receipts.delivered_at, NOW())
       WHERE message_receipts.read_at IS NULL`,
      [corsa_id, cliente_id, userId]
    );

    log("DEBUG_MARK_READ_SUCCESS", { rowCount });

    if (rowCount > 0) {
      const { getIO } = await import("../socket.js");
      getIO().to(`chat_${corsa_id}_${cliente_id}`).emit("message_read", { corsa_id, cliente_id });
    }
    
    return res.json({ success: true, markedAsReadCount: rowCount });
  } catch (err) {
    log("MARK_AS_READ_FAILED", { error: err.message });
    return res.status(500).json({ message: "error" });
  }
});

export default chatRouter;