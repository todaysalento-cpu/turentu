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

    log("REQUEST", "AUTH START", {
      requestId,
      method: req.method,
      url: req.originalUrl,
      headers: {
        authorization: req.headers.authorization ? "PRESENTE" : "ASSENTE",
        cookie: req.cookies?.token ? "PRESENTE" : "ASSENTE",
      },
    });

    const token =
      req.headers.authorization?.split(" ")[1] ||
      req.cookies?.token;

    if (!token) {
      log("AUTH", "TOKEN MANCANTE", { requestId });

      return res.status(401).json({
        message: "No token",
      });
    }

    const decoded = jwt.verify(token, JWT_SECRET);

    decoded.role = decoded.role?.toLowerCase();

    req.user = decoded;

    log("AUTH", "AUTH OK", {
      requestId,
      user: {
        id: decoded.id,
        role: decoded.role,
      },
    });

    next();

  } catch (err) {

    log("ERROR", "AUTH ERROR", {
      requestId: req.requestId,
      message: err.message,
      stack: err.stack,
    });

    return res.status(401).json({
      message: "Invalid token",
    });
  }
};

/* =======================================================
   INIT THREADS
======================================================= */

chatRouter.get("/init", authMiddleware, async (req, res) => {

  const requestId = req.requestId;

  const userId = Number(req.user.id);
  const role = req.user.role;

  const startedAt = Date.now();

  log("CHAT", "/init START", {
    requestId,
    userId,
    role,
  });

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

    log("DB", "QUERY THREADS", {
      requestId,
      query,
      params: [userId],
    });

    const { rows } = await pool.query(query, [userId]);

    log("DB", "THREADS RAW RESULT", {
      requestId,
      count: rows.length,
      rows,
    });

    const threads = rows.map((t) => {

      const last = t.last_message || {};

      return {
        id: `${t.corsa_id}_${t.cliente_id}`,

        corsa_id: Number(t.corsa_id),
        cliente_id: Number(t.cliente_id),
        driver_id: Number(t.driver_id),

        last_message: {
          text:
            last?.text ||
            last?.message ||
            "",

          created_at:
            last?.created_at || null,
        },

        unreadCount: Number(
          t.unreadcount ??
          t.unread_count ??
          0
        ),

        updated_at: Number(
          new Date(t.updated_at)
        ),
      };
    });

    log("CHAT", "/init RESPONSE", {
      requestId,
      threadsCount: threads.length,
      threads,
      durationMs: Date.now() - startedAt,
    });

    return res.json(threads);

  } catch (err) {

    log("ERROR", "/init ERROR", {
      requestId,
      message: err.message,
      stack: err.stack,
    });

    return res.status(500).json({
      message: "init error",
    });
  }
});

/* =======================================================
   MESSAGES
======================================================= */

chatRouter.get("/messages", authMiddleware, async (req, res) => {

  const requestId = req.requestId;

  const startedAt = Date.now();

  const corsa_id = Number(req.query.corsa_id);
  const cliente_id = Number(req.query.cliente_id);

  log("CHAT", "/messages START", {
    requestId,
    query: req.query,
    parsed: {
      corsa_id,
      cliente_id,
    },
  });

  if (!corsa_id || !cliente_id) {

    log("WARN", "PARAMS MANCANTI", {
      requestId,
      query: req.query,
    });

    return res.status(400).json({
      message: "missing params",
    });
  }

  try {

    const query = `
      SELECT *
      FROM messaggi
      WHERE corsa_id = $1
      AND cliente_id = $2
      ORDER BY created_at ASC
    `;

    log("DB", "QUERY MESSAGES", {
      requestId,
      query,
      params: [corsa_id, cliente_id],
    });

    const { rows } = await pool.query(
      query,
      [corsa_id, cliente_id]
    );

    log("DB", "MESSAGES RAW RESULT", {
      requestId,
      count: rows.length,
      rows,
    });

    const formatted = rows.map((m) => ({
      id: m.id,

      client_msg_id: m.client_msg_id,

      corsa_id: Number(m.corsa_id),
      cliente_id: Number(m.cliente_id),

      sender_id: Number(m.sender_id),

      text:
        m.text ||
        m.testo ||
        "",

      created_at: Number(m.created_at),

      status: {
        sent: true,
        delivered: false,
        read: false,
      },
    }));

    log("CHAT", "/messages RESPONSE", {
      requestId,
      messagesCount: formatted.length,
      formatted,
      durationMs: Date.now() - startedAt,
    });

    return res.json(formatted);

  } catch (err) {

    log("ERROR", "/messages ERROR", {
      requestId,
      message: err.message,
      stack: err.stack,
    });

    return res.status(500).json({
      message: "messages error",
    });
  }
});

export default chatRouter;