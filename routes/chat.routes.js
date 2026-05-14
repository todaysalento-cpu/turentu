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

/* =========================================================
   THREAD LIST
========================================================= */
chatRouter.get("/init", authMiddleware, async (req, res) => {
  const userId = Number(req.user.id);
  const role = req.user.role;

  try {
    let query;
    let params;

    if (role === "autista") {
      query = `
        SELECT *
        FROM chat_threads
        WHERE driver_id = $1
        ORDER BY updated_at DESC
      `;
      params = [userId];
    } else {
      query = `
        SELECT *
        FROM chat_threads
        WHERE cliente_id = $1
        ORDER BY updated_at DESC
      `;
      params = [userId];
    }

    const { rows } = await pool.query(query, params);

    const threads = rows.map((t) => {
      let lastMessage = null;

      try {
        lastMessage =
          typeof t.last_message === "string"
            ? JSON.parse(t.last_message)
            : t.last_message;
      } catch {
        lastMessage = null;
      }

      return {
        id: `${t.corsa_id}_${t.cliente_id}`,
        corsa_id: t.corsa_id,
        cliente_id: t.cliente_id,
        driver_id: t.driver_id,

        last_message: lastMessage,

        unreadCount: t.unread_count ?? 0,
        updated_at: new Date(t.updated_at).getTime(),
      };
    });

    return res.json(threads);
  } catch (err) {
    console.error("INIT ERROR:", err);
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

  try {
    const corsaId = Number(corsa_id);
    const clienteId = Number(cliente_id);

    if (!corsaId || !clienteId) {
      return res.status(400).json({ message: "invalid params" });
    }

    const { rows: threadRows } = await pool.query(
      `
      SELECT *
      FROM chat_threads
      WHERE corsa_id = $1 AND cliente_id = $2
      `,
      [corsaId, clienteId]
    );

    const thread = threadRows[0];

    if (!thread) {
      return res.status(404).json({ message: "thread not found" });
    }

    const isCliente = role === "cliente" && userId === thread.cliente_id;
    const isDriver = role === "autista" && userId === thread.driver_id;

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
    console.error("MESSAGES ERROR:", err);
    return res.status(500).json({ message: "messages error" });
  }
});

/* =========================================================
   SEND MESSAGE (FIXED)
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
      `
      SELECT *
      FROM chat_threads
      WHERE corsa_id = $1 AND cliente_id = $2
      `,
      [corsaId, clienteId]
    );

    const thread = threadRows[0];

    if (!thread) {
      return res.status(404).json({ message: "thread not found" });
    }

    const isCliente = role === "cliente" && senderId === thread.cliente_id;
    const isDriver = role === "autista" && senderId === thread.driver_id;

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

    await pool.query(
      `
      UPDATE chat_threads
      SET
        last_message = $3,
        unread_count = unread_count + 1,
        updated_at = NOW()
      WHERE corsa_id = $1 AND cliente_id = $2
      `,
      [
        corsaId,
        clienteId,
        JSON.stringify({
          text: trimmed,
          created_at: message.created_at,
        }),
      ]
    );

    return res.json({
      ok: true,
      message,
    });
  } catch (err) {
    console.error("SEND ERROR:", err);
    return res.status(500).json({ message: "send error" });
  }
});

export default chatRouter;