import express from "express";
import { pool } from "../db/db.js";
import jwt from "jsonwebtoken";
import { getIO } from "../socket.js";

const chatRouter = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "segreto-di-test";

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
  } catch {
    return res.status(401).json({ message: "Invalid token" });
  }
};

/* =========================================================
   INIT THREADS (UNREAD DERIVED FROM RECEIPTS)
========================================================= */
chatRouter.get("/init", authMiddleware, async (req, res) => {
  const userId = Number(req.user.id);
  const role = req.user.role;

  try {
    const { rows } = await pool.query(
      role === "autista"
        ? `SELECT * FROM chat_threads WHERE driver_id=$1 ORDER BY updated_at DESC`
        : `SELECT * FROM chat_threads WHERE cliente_id=$1 ORDER BY updated_at DESC`,
      [userId]
    );

    const threads = await Promise.all(
      rows.map(async (t) => {
        const { rows: unreadRows } = await pool.query(
          `
          SELECT COUNT(*)::int AS unread
          FROM message_receipts mr
          JOIN messaggi m ON m.id = mr.message_id
          WHERE mr.user_id = $1
            AND mr.read_at IS NULL
            AND m.corsa_id = $2
            AND m.cliente_id = $3
          `,
          [userId, t.corsa_id, t.cliente_id]
        );

        return {
          id: `${t.corsa_id}_${t.cliente_id}`,
          corsa_id: t.corsa_id,
          cliente_id: t.cliente_id,
          driver_id: t.driver_id,
          last_message: t.last_message,
          unreadCount: unreadRows[0]?.unread || 0,
          updated_at: new Date(t.updated_at).getTime(),
        };
      })
    );

    res.json(threads);
  } catch (err) {
    console.error("INIT ERROR:", err);
    res.status(500).json({ message: "init error" });
  }
});

/* =========================================================
   GET MESSAGES
========================================================= */
chatRouter.get("/messages", authMiddleware, async (req, res) => {
  const { corsa_id, cliente_id, limit = 30 } = req.query;

  try {
    const corsaId = Number(corsa_id);
    const clienteId = Number(cliente_id);

    if (!corsaId || !clienteId) {
      return res.status(400).json({ message: "invalid params" });
    }

    const { rows } = await pool.query(
      `
      SELECT *
      FROM messaggi
      WHERE corsa_id=$1
        AND cliente_id=$2
      ORDER BY created_at DESC
      LIMIT $3
      `,
      [corsaId, clienteId, Number(limit)]
    );

    const messages = rows
      .map((m) => ({
        ...m,
        created_at: new Date(m.created_at).getTime(),
      }))
      .reverse();

    res.json({
      messages,
      hasMore: rows.length === Number(limit),
      nextCursor: rows[0]
        ? new Date(rows[0].created_at).getTime()
        : null,
    });

  } catch (err) {
    console.error("MESSAGES ERROR:", err);
    res.status(500).json({ message: "messages error" });
  }
});

/* =========================================================
   SEND MESSAGE (RECEIPTS ONLY)
========================================================= */
chatRouter.post("/send", authMiddleware, async (req, res) => {
  const { corsa_id, cliente_id, text, client_msg_id } = req.body;

  const senderId = Number(req.user.id);
  const role = req.user.role;

  try {
    const corsaId = Number(corsa_id);
    const clienteId = Number(cliente_id);
    const trimmed = text?.trim();

    if (!corsaId || !clienteId || !trimmed) {
      return res.status(400).json({ message: "invalid params" });
    }

    const { rows: threadRows } = await pool.query(
      `SELECT * FROM chat_threads WHERE corsa_id=$1 AND cliente_id=$2`,
      [corsaId, clienteId]
    );

    const thread = threadRows[0];
    if (!thread) return res.status(404).json({ message: "thread not found" });

    const isCliente = role === "cliente" && senderId === thread.cliente_id;
    const isDriver = role === "autista" && senderId === thread.driver_id;

    if (!isCliente && !isDriver) {
      return res.status(403).json({ message: "forbidden" });
    }

    /* ================= INSERT MESSAGE ================= */
    const { rows } = await pool.query(
      `
      INSERT INTO messaggi (
        corsa_id,
        cliente_id,
        sender_id,
        testo,
        client_msg_id
      )
      VALUES ($1,$2,$3,$4,$5)
      RETURNING *
      `,
      [corsaId, clienteId, senderId, trimmed, client_msg_id]
    );

    const message = rows[0];

    /* ================= RECIPIENT ================= */
    const recipientId =
      role === "cliente"
        ? thread.driver_id
        : thread.cliente_id;

    /* ================= CREATE RECEIPT ================= */
    await pool.query(
      `
      INSERT INTO message_receipts (message_id, user_id)
      VALUES ($1, $2)
      `,
      [message.id, recipientId]
    );

    /* ================= UPDATE THREAD META ================= */
    await pool.query(
      `
      UPDATE chat_threads
      SET last_message=$3,
          updated_at=NOW()
      WHERE corsa_id=$1 AND cliente_id=$2
      `,
      [
        corsaId,
        clienteId,
        JSON.stringify({
          text: trimmed,
          created_at: new Date(message.created_at).getTime(),
        }),
      ]
    );

    /* ================= SOCKET ================= */
    const io = getIO();
    const room = `chat_${corsaId}_${clienteId}`;

    io.to(room).emit("new_message", {
      ...message,
      created_at: new Date(message.created_at).getTime(),
    });

    res.json({ ok: true, message });

  } catch (err) {
    console.error("SEND ERROR:", err);
    res.status(500).json({ message: "send error" });
  }
});

/* =========================================================
   MARK AS READ (RECEIPTS ONLY)
========================================================= */
chatRouter.post("/read", authMiddleware, async (req, res) => {
  const { corsa_id, cliente_id } = req.body;

  const userId = Number(req.user.id);

  try {
    const corsaId = Number(corsa_id);
    const clienteId = Number(cliente_id);

    await pool.query(
      `
      UPDATE message_receipts mr
      SET read_at = NOW()
      FROM messaggi m
      WHERE mr.message_id = m.id
        AND mr.user_id = $1
        AND m.corsa_id = $2
        AND m.cliente_id = $3
        AND mr.read_at IS NULL
      `,
      [userId, corsaId, clienteId]
    );

    const io = getIO();

    io.to(`chat_${corsaId}_${clienteId}`).emit("message_read", {
      corsa_id: corsaId,
      cliente_id: clienteId,
      reader_id: userId,
      read_at: Date.now(),
    });

    res.json({ ok: true });

  } catch (err) {
    console.error("READ ERROR:", err);
    res.status(500).json({ message: "read error" });
  }
});

export default chatRouter;