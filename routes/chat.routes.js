import express from "express";
import { pool } from "../db/db.js";
import jwt from "jsonwebtoken";
import crypto from "crypto";

const chatRouter = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "segreto-di-test";

/* ================= LOGGER ================= */

const log = (label, data = {}) =>
  console.log(
    JSON.stringify(
      {
        time: new Date().toISOString(),
        label,
        ...data,
      },
      null,
      2
    )
  );

/* ================= AUTH ================= */

const authMiddleware = (req, res, next) => {
  try {
    const token =
      req.headers.authorization?.split(" ")[1] ||
      req.cookies?.token;

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
   INIT THREADS (CLEAN)
   👉 NO unreadCount fake
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

    const threads = rows.map((t) => ({
      id: `${t.corsa_id}_${t.cliente_id}`,

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
    }));

    log("INIT_THREADS_OK", {
      userId,
      count: threads.length,
    });

    return res.json(threads);
  } catch (err) {
    log("INIT_THREADS_FAILED", { error: err.message });
    return res.status(500).json({ message: "init error" });
  }
});

/* =======================================================
   NORMALIZE MESSAGE
======================================================= */

const normalizeMessage = (m, threadId) => ({
  id: String(m.id),
  threadId,

  client_msg_id: m.client_msg_id ?? null,

  corsa_id: Number(m.corsa_id),
  cliente_id: Number(m.cliente_id),

  sender_id: Number(m.sender_id),

  text: m.testo ?? "",

  created_at: m.created_at
    ? Number(new Date(m.created_at))
    : Date.now(),

  status: {
    sent: true,
    delivered: Boolean(m.delivered_at),
    read: Boolean(m.read_at),
  },
});

/* =======================================================
   MESSAGES (READ SYSTEM FIXED)
======================================================= */

chatRouter.get("/messages", authMiddleware, async (req, res) => {
  const corsa_id = Number(req.query.corsa_id);
  const cliente_id = Number(req.query.cliente_id);
  const userId = Number(req.user.id);

  if (!corsa_id || !cliente_id) {
    return res.status(400).json({ message: "missing params" });
  }

  try {
    /* ======================================================
       🔥 STEP 1 — ENSURE RECEIPTS EXIST
    ====================================================== */

    await pool.query(
      `
      INSERT INTO message_receipts (message_id, user_id)
      SELECT m.id, $3
      FROM messaggi m
      WHERE m.corsa_id = $1 AND m.cliente_id = $2
      ON CONFLICT DO NOTHING
      `,
      [corsa_id, cliente_id, userId]
    );

    /* ======================================================
       🔥 STEP 2 — GET MESSAGES WITH STATUS
    ====================================================== */

    const { rows } = await pool.query(
      `
      SELECT 
        m.id,
        m.corsa_id,
        m.cliente_id,
        m.sender_id,
        m.testo,
        m.client_msg_id,
        m.created_at,
        mr.read_at,
        mr.delivered_at
      FROM messaggi m
      LEFT JOIN message_receipts mr
        ON mr.message_id = m.id
       AND mr.user_id = $3
      WHERE m.corsa_id = $1
        AND m.cliente_id = $2
      ORDER BY m.created_at ASC
      `,
      [corsa_id, cliente_id, userId]
    );

    const threadId = `${corsa_id}_${cliente_id}`;

    const messages = rows.map((m) =>
      normalizeMessage(m, threadId)
    );

    /* ======================================================
       🔥 DEBUG LOG (IMPORTANTISSIMO)
    ====================================================== */

    const unread = messages.filter(
      (m) => m.sender_id !== userId && !m.status.read
    );

    log("MESSAGES_LOADED", {
      threadId,
      total: messages.length,
      unread: unread.length,
      lastMessage: messages.at(-1)?.id,
    });

    return res.json(messages);
  } catch (err) {
    log("MESSAGES_FAILED", { error: err.message });
    return res.status(500).json({ message: "messages error" });
  }
});

export default chatRouter;