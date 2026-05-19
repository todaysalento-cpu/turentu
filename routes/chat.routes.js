import express from "express";
import { pool } from "../db/db.js";
import jwt from "jsonwebtoken";

const chatRouter = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "segreto-di-test";

const log = (label, data = {}) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), label, ...data }, null, 2));

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

/* =======================================================
   INIT THREADS - QUERY CORRETTA
======================================================= */
chatRouter.get("/init", authMiddleware, async (req, res) => {
  const userId = Number(req.user.id);
  const role = req.user.role;

  try {
    // Usiamo una subquery con NOT EXISTS per contare i messaggi non letti dall'utente corrente
    const query = `
      SELECT ct.*, 
             c.origine_address, 
             c.destinazione_address, 
             c.start_datetime,
             (
               SELECT COUNT(m.id)::int
               FROM messaggi m
               WHERE m.corsa_id = ct.corsa_id 
                 AND m.cliente_id = ct.cliente_id 
                 AND m.sender_id != $1
                 AND NOT EXISTS (
                   SELECT 1 FROM message_receipts mr 
                   WHERE mr.message_id = m.id AND mr.user_id = $1
                 )
             ) as unread_count
      FROM chat_threads ct
      JOIN corse c ON ct.corsa_id = c.id
      WHERE ${role === "autista" ? "ct.driver_id=$1" : "ct.cliente_id=$1"}
      ORDER BY ct.updated_at DESC
    `;

    const { rows } = await pool.query(query, [userId]);

    // Debug: logghiamo il primo risultato per verificare se unread_count arriva
    if (rows.length > 0) {
      log("DEBUG_INIT_DATA", { sample: rows[0] });
    }

    const threads = rows.map((t) => ({
      id: `${t.corsa_id}_${t.cliente_id}`,
      corsa_id: Number(t.corsa_id),
      cliente_id: Number(t.cliente_id),
      driver_id: Number(t.driver_id),
      
      origine_address: t.origine_address ?? "N/D",
      destinazione_address: t.destinazione_address ?? "N/D",
      start_datetime: t.start_datetime ? new Date(t.start_datetime).toISOString() : null,
      
      // Assicuriamoci che unreadCount sia sempre un numero
      unreadCount: Number(t.unread_count || 0),

      lastMessage: t.last_message?.text ?? "",
      lastMessageTime: t.last_message?.created_at
        ? Number(new Date(t.last_message.created_at))
        : Number(new Date(t.updated_at)),

      updated_at: Number(new Date(t.updated_at)),
    }));

    log("INIT_THREADS_OK", { userId, count: threads.length });
    return res.json(threads);
  } catch (err) {
    log("INIT_THREADS_FAILED", { error: err.message });
    return res.status(500).json({ message: "init error" });
  }
});

/* =======================================================
   MESSAGES
======================================================= */
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
       LEFT JOIN message_receipts mr ON mr.message_id = m.id AND mr.user_id = $3
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
        delivered: !!m.delivered_at,
        read: !!m.read_at,
      },
    }));

    return res.json(messages);
  } catch (err) {
    log("MESSAGES_FAILED", { error: err.message });
    return res.status(500).json({ message: "messages error" });
  }
});

/* =======================================================
   MARK THREAD AS READ
======================================================= */
chatRouter.post("/messages/read", authMiddleware, async (req, res) => {
  const corsa_id = Number(req.body.corsa_id);
  const cliente_id = Number(req.body.cliente_id);
  const userId = Number(req.user.id);

  try {
    const { rowCount } = await pool.query(
      `INSERT INTO message_receipts (message_id, user_id, read_at)
       SELECT m.id, $3, NOW()
       FROM messaggi m
       WHERE m.corsa_id = $1 AND m.cliente_id = $2 AND m.sender_id != $3
       ON CONFLICT (message_id, user_id) DO UPDATE SET read_at = NOW()
       WHERE message_receipts.read_at IS NULL`,
      [corsa_id, cliente_id, userId]
    );

    return res.json({ success: true, markedAsReadCount: rowCount });
  } catch (err) {
    log("MARK_AS_READ_FAILED", { error: err.message });
    return res.status(500).json({ message: "error" });
  }
});

export default chatRouter;