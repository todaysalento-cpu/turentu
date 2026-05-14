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

    if (!token) {
      console.log("❌ NO TOKEN");
      return res.status(401).json({ message: "No token" });
    }

    const decoded = jwt.verify(token, JWT_SECRET);

    decoded.role = decoded.role.toLowerCase();

    req.user = decoded;

    console.log("🟢 AUTH OK", {
      userId: decoded.id,
      role: decoded.role,
    });

    next();

  } catch (err) {
    console.error("❌ AUTH ERROR", err);
    return res.status(401).json({ message: "Invalid token" });
  }
};

/* ======================= THREAD LIST ======================= */
chatRouter.get("/init", authMiddleware, async (req, res) => {
  const userId = Number(req.user.id);
  const role = req.user.role;

  console.log("🚀 /chat/init START", {
    userId,
    role,
  });

  try {

    const query = `
      SELECT
        corsa_id,
        cliente_id,
        driver_id,
        last_message,
        unread_count,
        updated_at
      FROM chat_threads
      WHERE ${role === "autista"
        ? "driver_id = $1"
        : "cliente_id = $1"}
      ORDER BY updated_at DESC
    `;

    console.log("📡 QUERY:", query);
    console.log("📡 PARAMS:", [userId]);

    const { rows } = await pool.query(query, [userId]);

    console.log("📦 RAW DB ROWS:", rows);

    const threads = rows.map((t) => ({
      id: `${t.corsa_id}_${t.cliente_id}`,

      corsa_id: t.corsa_id,
      cliente_id: t.cliente_id,
      driver_id: t.driver_id,

      last_message: t.last_message,
      unreadCount: t.unread_count,

      updated_at: t.updated_at,
    }));

    console.log("🧵 FINAL THREADS:", threads);

    res.json(threads);

  } catch (err) {
    console.error("❌ INIT ERROR:", err);

    res.status(500).json({
      message: "init error",
    });
  }
});

/* ======================= MESSAGES ======================= */
chatRouter.get("/messages", authMiddleware, async (req, res) => {
  const {
    corsa_id,
    cliente_id,
    cursor,
    limit = 30,
  } = req.query;

  console.log("🚀 /chat/messages", {
    corsa_id,
    cliente_id,
    cursor,
    limit,
  });

  try {

    const values = [
      corsa_id,
      cliente_id,
      Number(limit),
    ];

    let cursorQuery = "";

    if (cursor) {
      values.push(new Date(Number(cursor)));
      cursorQuery = `AND created_at < $4`;
    }

    console.log("📡 MESSAGE QUERY PARAMS:", values);

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

    console.log("📦 RAW MESSAGES:", rows);

    const messages = rows
      .map((m) => ({
        ...m,
        created_at: new Date(m.created_at).getTime(),
      }))
      .reverse();

    console.log("💬 FINAL MESSAGES:", messages);

    res.json({
      messages,

      hasMore: rows.length === Number(limit),

      nextCursor: rows[0]?.created_at
        ? new Date(rows[0].created_at).getTime()
        : null,
    });

  } catch (err) {
    console.error("❌ PAGINATION ERROR:", err);

    res.status(500).json({
      message: "pagination error",
    });
  }
});

/* ======================= SEND ======================= */
chatRouter.post("/send", authMiddleware, async (req, res) => {
  const {
    corsa_id,
    cliente_id,
    text,
    client_msg_id,
  } = req.body;

  const sender_id = Number(req.user.id);

  console.log("🚀 /chat/send", {
    corsa_id,
    cliente_id,
    sender_id,
    text,
    client_msg_id,
  });

  try {

    const trimmed = text?.trim();

    if (!trimmed) {
      console.log("❌ EMPTY MESSAGE");
      return res.status(400).json({
        message: "empty message",
      });
    }

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
        jsonb_build_object(
          'autista', false,
          'cliente', false
        ),
        jsonb_build_object(
          'sent', true,
          'delivered', false,
          'read', false
        )
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
      [
        corsa_id,
        cliente_id,
        sender_id,
        trimmed,
        client_msg_id,
      ]
    );

    console.log("📦 INSERT RESULT:", rows);

    if (!rows.length) {

      console.log("⚠️ DUPLICATE MESSAGE");

      return res.json({
        ok: true,
        duplicate: true,
      });
    }

    const message = {
      ...rows[0],
      created_at: new Date(rows[0].created_at).getTime(),
    };

    console.log("✅ FINAL MESSAGE:", message);

    /* ================= DEBUG CHAT THREADS ================= */
    const threadCheck = await pool.query(
      `
      SELECT *
      FROM chat_threads
      WHERE corsa_id = $1
        AND cliente_id = $2
      `,
      [corsa_id, cliente_id]
    );

    console.log("🧵 THREAD AFTER INSERT:", threadCheck.rows);

    return res.json({
      ok: true,
      message,
    });

  } catch (err) {
    console.error("❌ SEND ERROR:", err);

    res.status(500).json({
      message: "send error",
    });
  }
});

export default chatRouter;