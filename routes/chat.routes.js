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

/* ================= MESSAGES (IL PUNTO CRITICO) ================= */
chatRouter.get("/messages", authMiddleware, async (req, res) => {
  const corsa_id = Number(req.query.corsa_id);
  const cliente_id = Number(req.query.cliente_id);
  const userId = req.user.id;

  if (!corsa_id || !cliente_id) return res.status(400).json({ message: "missing params" });

  try {
    // LOG DI DEBUG: Verifichiamo chi sta interrogando e cosa cerca
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

    // LOG DI DEBUG: Controlliamo quanti messaggi hanno read_at presente
    const readCount = rows.filter(r => r.read_at !== null).length;
    log("DEBUG_MESSAGES_RESULT", { total: rows.length, readCount });

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
    // LOG DI DEBUG: Prima dell'insert
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