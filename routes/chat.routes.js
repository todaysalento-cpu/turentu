import express from "express";
import { pool } from "../db/db.js";
import jwt from "jsonwebtoken";

const chatRouter = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "segreto-di-test";

/* ======================= AUTH ======================= */
const authMiddleware = (req, res, next) => {
  try {
    const token =
      req.headers.authorization?.split(" ")[1] ||
      req.cookies?.token;

    if (!token) return res.status(401).json({ message: "No token" });

    const decoded = jwt.verify(token, JWT_SECRET);
    decoded.role = decoded.role.toLowerCase();

    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ message: "Invalid token" });
  }
};

/* ======================= THREAD LIST (100% DB SOURCE OF TRUTH) ======================= */
chatRouter.get("/init", authMiddleware, async (req, res) => {
  const userId = Number(req.user.id);
  const role = req.user.role;

  try {
    const { rows } = await pool.query(
      `
      SELECT
        corsa_id,
        cliente_id,
        driver_id,
        last_message,
        unread_count,
        updated_at
      FROM chat_threads
      WHERE ${role === "autista" ? "driver_id = $1" : "cliente_id = $1"}
      ORDER BY updated_at DESC
      `,
      [userId]
    );

    const threads = rows.map(t => ({
      id: `${t.corsa_id}_${t.cliente_id}`,
      corsa_id: t.corsa_id,
      cliente_id: t.cliente_id,
      last_message: t.last_message,
      unreadCount: t.unread_count,
      updated_at: t.updated_at,
    }));

    res.json(threads);

  } catch (err) {
    console.error("init error:", err);
    res.status(500).json({ message: "init error" });
  }
});

/* ======================= MESSAGES (ONLY FOR CHAT VIEW) ======================= */
chatRouter.get("/messages", authMiddleware, async (req, res) => {
  const { corsa_id, cliente_id, cursor, limit = 30 } = req.query;

  try {
    const values = [corsa_id, cliente_id, Number(limit)];
    let cursorQuery = "";

    if (cursor) {
      values.push(new Date(Number(cursor)));
      cursorQuery = `AND created_at < $4`;
    }

    const { rows } = await pool.query(
      `
      SELECT
        id,
        corsa_id,
        cliente_id,
        sender_id,
        testo AS text,
        created_at,
        read_status,
        client_msg_id,
        status
      FROM messaggi
      WHERE corsa_id = $1
        AND cliente_id = $2
        ${cursorQuery}
      ORDER BY created_at DESC
      LIMIT $3
      `,
      values
    );

    res.json({
      messages: rows
        .map(m => ({
          ...m,
          created_at: new Date(m.created_at).getTime(),
        }))
        .reverse(),

      hasMore: rows.length === Number(limit),

      nextCursor: rows[0]?.created_at
        ? new Date(rows[0].created_at).getTime()
        : null,
    });

  } catch (err) {
    console.error("pagination error:", err);
    res.status(500).json({ message: "pagination error" });
  }
});

/* ======================= SEND (HTTP FALLBACK ONLY) ======================= */
/*
  IMPORTANT:
  - NON aggiorni thread qui
  - lo fa il TRIGGER PostgreSQL sync_chat_thread()
  - backend resta leggero e scalabile
*/
chatRouter.post("/send", authMiddleware, async (req, res) => {
  const { corsa_id, cliente_id, text, client_msg_id } = req.body;
  const sender_id = Number(req.user.id);

  try {
    const { rows } = await pool.query(
      `
      INSERT INTO messaggi (
        corsa_id,
        cliente_id,
        sender_id,
        testo,
        client_msg_id,
        read_status,
        status
      )
      VALUES (
        $1,$2,$3,$4,$5,
        jsonb_build_object('autista', false, 'cliente', false),
        jsonb_build_object('sent', true, 'delivered', false, 'read', false)
      )
      ON CONFLICT (client_msg_id) DO NOTHING
      RETURNING
        id,
        corsa_id,
        cliente_id,
        sender_id,
        testo AS text,
        created_at,
        read_status,
        client_msg_id,
        status
      `,
      [corsa_id, cliente_id, sender_id, text.trim(), client_msg_id]
    );

    if (!rows.length) {
      return res.json({ ok: true, duplicate: true });
    }

    return res.json({
      ok: true,
      message: {
        ...rows[0],
        created_at: new Date(rows[0].created_at).getTime(),
      },
    });

  } catch (err) {
    console.error("send error:", err);
    res.status(500).json({ message: "send error" });
  }
});

export default chatRouter;