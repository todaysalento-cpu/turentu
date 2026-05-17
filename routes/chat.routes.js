import express from "express";
import { pool } from "../db/db.js";
import jwt from "jsonwebtoken";
import crypto from "crypto";

const chatRouter = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "segreto-di-test";

/* =======================================================
   LOGGER
======================================================= */

const log = (type, label, data = null) => {
  const time = new Date().toISOString();

  console.log(
    JSON.stringify(
      {
        time,
        type,
        label,
        ...(data && { data }),
      },
      null,
      2
    )
  );
};

/* =======================================================
   AUTH
======================================================= */

const authMiddleware = (req, res, next) => {
  try {
    const requestId = crypto.randomUUID();
    req.requestId = requestId;

    const token =
      req.headers.authorization?.split(" ")[1] ||
      req.cookies?.token;

    if (!token) {
      return res.status(401).json({ message: "No token" });
    }

    const decoded = jwt.verify(token, JWT_SECRET);

    decoded.role = decoded.role?.toLowerCase();
    req.user = decoded;

    next();
  } catch (err) {
    return res.status(401).json({ message: "Invalid token" });
  }
};

/* =======================================================
   INIT THREADS
======================================================= */

chatRouter.get("/init", authMiddleware, async (req, res) => {
  const userId = Number(req.user.id);
  const role = req.user.role;

  try {
    const query =
      role === "autista"
        ? `
          SELECT *
          FROM chat_threads
          WHERE driver_id=$1
          ORDER BY updated_at DESC
        `
        : `
          SELECT *
          FROM chat_threads
          WHERE cliente_id=$1
          ORDER BY updated_at DESC
        `;

    const { rows } = await pool.query(query, [userId]);

    const threads = rows.map((t) => {
      const threadId = `${t.corsa_id}_${t.cliente_id}`;

      return {
        id: threadId,

        corsa_id: Number(t.corsa_id),
        cliente_id: Number(t.cliente_id),
        driver_id: Number(t.driver_id),

        origine: t.origine ?? "",
        destinazione: t.destinazione ?? "",

        lastMessage: t.last_message?.text ?? "",

        lastMessageTime: t.last_message?.created_at
          ? Number(new Date(t.last_message.created_at))
          : Number(new Date(t.updated_at)),

        updated_at: Number(new Date(t.updated_at)),

        // ⚠️ ancora fallback (vera versione sarebbe receipts-based)
        unreadCount: Number(t.unreadcount ?? 0),
      };
    });

    return res.json(threads);
  } catch (err) {
    log("ERROR", "INIT_THREADS_FAILED", { message: err.message });
    return res.status(500).json({ message: "init error" });
  }
});

/* =======================================================
   MESSAGES (🔥 FIXED WITH RECEIPTS)
======================================================= */

chatRouter.get("/messages", authMiddleware, async (req, res) => {
  const corsa_id = Number(req.query.corsa_id);
  const cliente_id = Number(req.query.cliente_id);
  const userId = Number(req.user.id);

  if (!corsa_id || !cliente_id) {
    return res.status(400).json({ message: "missing params" });
  }

  try {
    const query = `
      SELECT 
        m.*,
        mr.read_at,
        mr.delivered_at
      FROM messaggi m
      LEFT JOIN message_receipts mr
        ON mr.message_id = m.id
       AND mr.user_id = $3
      WHERE m.corsa_id = $1
        AND m.cliente_id = $2
      ORDER BY m.created_at ASC
    `;

    const { rows } = await pool.query(query, [
      corsa_id,
      cliente_id,
      userId,
    ]);

    const threadId = `${corsa_id}_${cliente_id}`;

    const formatted = rows.map((m) => ({
      id: String(m.id),

      threadId,

      client_msg_id: m.client_msg_id ?? null,

      corsa_id: Number(m.corsa_id),
      cliente_id: Number(m.cliente_id),

      sender_id: Number(m.sender_id),

      // 🔥 FIX DB FIELD (NO m.text)
      text: m.testo ?? "",

      created_at: m.created_at
        ? Number(new Date(m.created_at))
        : Date.now(),

      // 🔥 REAL STATE FROM DB
      status: {
        sent: true,
        delivered: !!m.delivered_at,
        read: !!m.read_at,
      },
    }));

    return res.json(formatted);
  } catch (err) {
    log("ERROR", "MESSAGES_FAILED", { message: err.message });
    return res.status(500).json({ message: "messages error" });
  }
});

export default chatRouter;