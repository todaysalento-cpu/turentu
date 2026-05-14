import express from "express";
import { pool } from "../db/db.js";
import jwt from "jsonwebtoken";

const chatRouter = express.Router();

const JWT_SECRET =
  process.env.JWT_SECRET ||
  "segreto-di-test";

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
    decoded.role = decoded.role?.toLowerCase();

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

/* =========================================================
   THREAD LIST
========================================================= */
chatRouter.get("/init", authMiddleware, async (req, res) => {
  const userId = Number(req.user.id);
  const role = req.user.role;

  console.log("🚀 /chat/init START", { userId, role });

  try {
    const query =
      role === "autista"
        ? `
          SELECT
            ct.corsa_id,
            ct.cliente_id,
            ct.driver_id,
            ct.last_message,
            ct.unread_count,
            ct.updated_at
          FROM chat_threads ct
          JOIN corse c ON c.id = ct.corsa_id
          JOIN veicolo v ON v.id = c.veicolo_id
          WHERE v.driver_id = $1
          ORDER BY ct.updated_at DESC
        `
        : `
          SELECT
            corsa_id,
            cliente_id,
            driver_id,
            last_message,
            unread_count,
            updated_at
          FROM chat_threads
          WHERE cliente_id = $1
          ORDER BY updated_at DESC
        `;

    console.log("📡 QUERY INIT:", query);
    console.log("📡 PARAMS:", [userId]);

    const { rows } = await pool.query(query, [userId]);

    console.log("📦 THREAD RAW:", rows);

    const threads = rows.map((t) => ({
      id: `${t.corsa_id}_${t.cliente_id}`,
      corsa_id: t.corsa_id,
      cliente_id: t.cliente_id,
      driver_id: t.driver_id,
      last_message: t.last_message,
      unreadCount: t.unread_count,
      updated_at: new Date(t.updated_at).getTime(),
    }));

    console.log("🧵 THREADS FINAL:", threads.length);

    return res.json(threads);
  } catch (err) {
    console.error("❌ INIT ERROR:", err);
    return res.status(500).json({ message: "init error" });
  }
});

/* =========================================================
   GET MESSAGES
========================================================= */
chatRouter.get("/messages", authMiddleware, async (req, res) => {
  const { corsa_id, cliente_id, cursor, limit = 30 } = req.query;

  const userId = Number(req.user.id);
  const role = req.user.role;

  console.log("🚀 /chat/messages", {
    corsa_id,
    cliente_id,
    cursor,
    limit,
  });

  try {
    const corsaId = Number(corsa_id);
    const clienteId = Number(cliente_id);

    if (!corsaId || !clienteId) {
      return res.status(400).json({ message: "invalid params" });
    }

    const threadCheck = await pool.query(
      `
      SELECT ct.*, v.driver_id
      FROM chat_threads ct
      JOIN corse c ON c.id = ct.corsa_id
      JOIN veicolo v ON v.id = c.veicolo_id
      WHERE ct.corsa_id = $1
        AND ct.cliente_id = $2
      `,
      [corsaId, clienteId]
    );

    const thread = threadCheck.rows[0];

    console.log("🧵 THREAD CHECK:", thread);

    if (!thread) {
      return res.status(404).json({ message: "thread not found" });
    }

    const isCliente =
      role === "cliente" &&
      Number(clienteId) === userId;

    const isDriver =
      role === "autista" &&
      Number(thread.driver_id) === userId;

    console.log("🔐 AUTH CHECK", { isCliente, isDriver });

    if (!isCliente && !isDriver) {
      return res.status(403).json({ message: "forbidden" });
    }

    const values = [corsaId, clienteId, Number(limit)];
    let cursorQuery = "";

    if (cursor) {
      values.push(new Date(Number(cursor)));
      cursorQuery = `AND created_at < $4`;
    }

    const { rows } = await pool.query(
      `
      SELECT *
      FROM messaggi
      WHERE corsa_id = $1
        AND cliente_id = $2
        ${cursorQuery}
      ORDER BY created_at DESC
      LIMIT $3
      `,
      values
    );

    console.log("💬 MESSAGES RAW:", rows.length);

    const messages = rows
      .map((m) => ({
        ...m,
        created_at: new Date(m.created_at).getTime(),
      }))
      .reverse();

    return res.json({
      messages,
      hasMore: rows.length === Number(limit),
      nextCursor: rows[0]
        ? new Date(rows[0].created_at).getTime()
        : null,
    });
  } catch (err) {
    console.error("❌ MESSAGES ERROR:", err);
    return res.status(500).json({ message: "messages error" });
  }
});

/* =========================================================
   SEND MESSAGE
========================================================= */
chatRouter.post("/send", authMiddleware, async (req, res) => {
  const { corsa_id, cliente_id, text, client_msg_id } = req.body;

  const senderId = Number(req.user.id);
  const role = req.user.role;

  console.log("🚀 /chat/send", {
    corsa_id,
    cliente_id,
    senderId,
    text,
  });

  try {
    const corsaId = Number(corsa_id);
    const clienteId = Number(cliente_id);
    const trimmed = text?.trim();

    if (!corsaId || !clienteId) {
      return res.status(400).json({ message: "invalid params" });
    }

    if (!trimmed) {
      return res.status(400).json({ message: "empty message" });
    }

    const threadCheck = await pool.query(
      `
      SELECT ct.*, v.driver_id
      FROM chat_threads ct
      JOIN corse c ON c.id = ct.corsa_id
      JOIN veicolo v ON v.id = c.veicolo_id
      WHERE ct.corsa_id = $1
        AND ct.cliente_id = $2
      `,
      [corsaId, clienteId]
    );

    const thread = threadCheck.rows[0];

    console.log("🧵 THREAD SEND CHECK:", thread);

    if (!thread) {
      return res.status(404).json({ message: "thread not found" });
    }

    const isCliente =
      role === "cliente" &&
      Number(clienteId) === senderId;

    const isDriver =
      role === "autista" &&
      Number(thread.driver_id) === senderId;

    console.log("🔐 SEND AUTH", { isCliente, isDriver });

    if (!isCliente && !isDriver) {
      return res.status(403).json({ message: "forbidden" });
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
        jsonb_build_object('autista',false,'cliente',false),
        jsonb_build_object('sent',true,'delivered',false,'read',false)
      )
      ON CONFLICT (client_msg_id) DO NOTHING
      RETURNING *
      `,
      [corsaId, clienteId, senderId, trimmed, client_msg_id]
    );

    if (!rows.length) {
      return res.json({ ok: true, duplicate: true });
    }

    const message = {
      ...rows[0],
      created_at: new Date(rows[0].created_at).getTime(),
    };

    console.log("✅ MESSAGE SENT:", message.id);

    await pool.query(
      `
      UPDATE chat_threads
      SET
        last_message = $3,
        unread_count = unread_count + 1,
        updated_at = NOW()
      WHERE corsa_id = $1
        AND cliente_id = $2
      `,
      [
        corsaId,
        clienteId,
        JSON.stringify({
          text: message.text,
          created_at: message.created_at,
        }),
      ]
    );

    console.log("🧵 THREAD UPDATED");

    return res.json({
      ok: true,
      message,
    });
  } catch (err) {
    console.error("❌ SEND ERROR:", err);
    return res.status(500).json({ message: "send error" });
  }
});

export default chatRouter;