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
             COALESCE((
               SELECT COUNT(m.id)::int
               FROM messaggi m
               LEFT JOIN message_receipts mr ON mr.message_id = m.id AND mr.user_id = $1
               WHERE m.corsa_id = ct.corsa_id 
                 AND m.cliente_id = ct.cliente_id 
                 AND m.sender_id != $1
                 AND mr.id IS NULL
             ), 0) as unread_count
      FROM chat_threads ct
      JOIN corse c ON ct.corsa_id = c.id
      WHERE ${role === "autista" ? "ct.driver_id = $1" : "ct.cliente_id = $1"}
      ORDER BY ct.updated_at DESC
    `;

    const { rows } = await pool.query(query, [userId]);

    // DEBUG: Loggiamo cosa arriva dal database
    log("DEBUG_INIT_DB_ROWS", { 
      totalRows: rows.length, 
      firstRowSample: rows[0] ? { corsa_id: rows[0].corsa_id, unread_count: rows[0].unread_count } : null 
    });

    const threads = rows.map((t) => {
      const unreadCount = Number(t.unread_count ?? 0);
      
      // DEBUG: Loggiamo la trasformazione per ogni thread
      log("DEBUG_INIT_THREAD_MAP", { 
        corsa_id: t.corsa_id, 
        db_unread_count: t.unread_count, 
        final_unreadCount: unreadCount 
      });

      return {
        id: `${t.corsa_id}_${t.cliente_id}`,
        corsa_id: Number(t.corsa_id),
        cliente_id: Number(t.cliente_id),
        driver_id: Number(t.driver_id),
        origine_address: t.origine_address ?? "N/D",
        destinazione_address: t.destinazione_address ?? "N/D",
        start_datetime: t.start_datetime ? new Date(t.start_datetime).toISOString() : null,
        unreadCount: unreadCount,
        lastMessage: t.last_message?.text ?? "",
        lastMessageTime: t.last_message?.created_at
          ? Number(new Date(t.last_message.created_at))
          : Number(new Date(t.updated_at)),
        updated_at: Number(new Date(t.updated_at)),
      };
    });

    log("INIT_THREADS_OK", { userId, count: threads.length });
    return res.json(threads);
  } catch (err) {
    log("INIT_THREADS_FAILED", { error: err.message, stack: err.stack });
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
      `SELECT m.id, m.corsa_id, m.cliente_id, m.sender_id, m.testo, m.created_at, mr.read_at, mr.delivered_at
       FROM messaggi m
       LEFT JOIN message_receipts mr ON mr.message_id = m.id AND mr.user_id = $3 AND mr.device_id = 'api'
       WHERE m.corsa_id = $1 AND m.cliente_id = $2
       ORDER BY m.created_at ASC`,
      [corsa_id, cliente_id, userId]
    );

    const messages = rows.map((m) => ({
      id: String(m.id),
      threadId,
      sender_id: Number(m.sender_id),
      text: m.testo ?? "",
      created_at: m.created_at ? Number(new Date(m.created_at)) : Date.now(),
      status: {
        sent: true,
        delivered: Boolean(m.delivered_at),
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
    const { rowCount } = await pool.query(
      `INSERT INTO message_receipts (message_id, user_id, device_id, read_at, delivered_at)
       SELECT m.id, $3, 'api', NOW(), NOW()
       FROM messaggi m
       WHERE m.corsa_id = $1 AND m.cliente_id = $2 AND m.sender_id != $3
       ON CONFLICT (message_id, user_id, device_id) 
       DO UPDATE SET read_at = COALESCE(message_receipts.read_at, NOW()), delivered_at = COALESCE(message_receipts.delivered_at, NOW())
       WHERE message_receipts.read_at IS NULL`,
      [corsa_id, cliente_id, userId]
    );

    if (rowCount > 0) {
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
          .emit("message_read", { corsa_id, cliente_id });
      }
    }
    return res.json({ success: true, markedAsReadCount: rowCount });
  } catch (err) {
    log("MARK_AS_READ_FAILED", { error: err.message });
    return res.status(500).json({ message: "error" });
  }
});

export default chatRouter;