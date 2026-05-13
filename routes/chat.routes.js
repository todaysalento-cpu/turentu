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
  } catch (err) {
    return res.status(401).json({ message: "Invalid token" });
  }
};

/* ======================= THREAD INIT ======================= */
chatRouter.get("/init", authMiddleware, async (req, res) => {
  const userId = Number(req.user.id);
  const role = req.user.role;

  const LIMIT = 30;

  try {
    let rows = [];

    if (role === "autista") {
      const r = await pool.query(
        `SELECT DISTINCT
            c.id AS corsa_id,
            p.cliente_id,
            c.origine_address,
            c.destinazione_address,
            c.start_datetime
         FROM corse c
         INNER JOIN veicolo v ON v.id = c.veicolo_id
         INNER JOIN prenotazioni p ON p.corsa_id = c.id
         WHERE v.driver_id = $1
         ORDER BY c.start_datetime DESC`,
        [userId]
      );

      rows = r.rows;
    } else {
      const r = await pool.query(
        `SELECT DISTINCT
            c.id AS corsa_id,
            p.cliente_id,
            c.origine_address,
            c.destinazione_address,
            c.start_datetime
         FROM prenotazioni p
         INNER JOIN corse c ON c.id = p.corsa_id
         WHERE p.cliente_id = $1
         ORDER BY c.start_datetime DESC`,
        [userId]
      );

      rows = r.rows;
    }

    const threads = await Promise.all(
      rows.map(async (r) => {
        const corsaId = r.corsa_id;
        const clienteId = r.cliente_id;

        const threadId = `${corsaId}_${clienteId}`;

        const unread = await pool.query(
          `SELECT COUNT(*)::int AS count
           FROM messaggi
           WHERE corsa_id = $1
             AND cliente_id = $2
             AND sender_id != $3
             AND (read_status->>$4) = 'false'`,
          [corsaId, clienteId, userId, role]
        );

        const messages = await pool.query(
          `SELECT
              id,
              client_msg_id,
              corsa_id,
              cliente_id,
              sender_id,
              testo AS text,
              created_at,
              read_status
           FROM messaggi
           WHERE corsa_id = $1
             AND cliente_id = $2
           ORDER BY created_at DESC
           LIMIT $3`,
          [corsaId, clienteId, LIMIT]
        );

        return {
          id: threadId,
          corsa_id: corsaId,
          cliente_id: clienteId,
          origine: r.origine_address,
          destinazione: r.destinazione_address,
          start_datetime: r.start_datetime,
          unreadCount: unread.rows?.[0]?.count || 0,
          messages: messages.rows.reverse(),
          hasMore: messages.rows.length === LIMIT,
        };
      })
    );

    res.json(threads);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "init error" });
  }
});

/* ======================= PAGINATION ======================= */
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
      `SELECT
          id,
          client_msg_id,
          corsa_id,
          cliente_id,
          sender_id,
          testo AS text,
          created_at,
          read_status
       FROM messaggi
       WHERE corsa_id = $1
         AND cliente_id = $2
         ${cursorQuery}
       ORDER BY created_at DESC
       LIMIT $3`,
      values
    );

    res.json({
      messages: rows.reverse(),
      hasMore: rows.length === Number(limit),
      nextCursor: rows[0]?.created_at
        ? new Date(rows[0].created_at).getTime()
        : null,
    });
  } catch (err) {
    res.status(500).json({ message: "pagination error" });
  }
});

/* ======================= SEND MESSAGE (IDEMPOTENT) ======================= */
chatRouter.post("/send", authMiddleware, async (req, res) => {
  const { corsa_id, cliente_id, text, client_msg_id } = req.body;

  const sender_id = Number(req.user.id);

  try {
    const { rows } = await pool.query(
      `INSERT INTO messaggi (
        corsa_id,
        cliente_id,
        sender_id,
        testo,
        client_msg_id,
        read_status
      )
      VALUES ($1,$2,$3,$4,$5,
        CASE
          WHEN $3 = (SELECT driver_id FROM veicolo v
                     JOIN corse c ON c.veicolo_id = v.id
                     WHERE c.id = $1)
          THEN '{"autista": true, "cliente": false}'
          ELSE '{"autista": false, "cliente": true}'
        END
      )
      ON CONFLICT (client_msg_id) DO NOTHING
      RETURNING *`,
      [corsa_id, cliente_id, sender_id, text.trim(), client_msg_id]
    );

    if (!rows.length) {
      return res.json({ ok: true, duplicate: true });
    }

    const msg = rows[0];

    req.io?.to(`chat_${corsa_id}_${cliente_id}`).emit("new_message", msg);

    res.json({ ok: true, message: msg });
  } catch (err) {
    res.status(500).json({ message: "send error" });
  }
});

/* ======================= SOCKET ======================= */
export const attachChatSocket = (io) => {
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error("no token"));

      const decoded = jwt.verify(token, JWT_SECRET);
      decoded.role = decoded.role.toLowerCase();

      socket.user = decoded;
      next();
    } catch {
      next(new Error("invalid token"));
    }
  });

  io.on("connection", (socket) => {
    socket.on("join_chat", ({ corsa_id, cliente_id }) => {
      const room = `chat_${corsa_id}_${cliente_id}`;
      socket.join(room);
    });

    socket.on("send_message", async (payload) => {
      const { corsa_id, cliente_id, text, client_msg_id } = payload;

      if (!text?.trim() || !client_msg_id) return;

      const sender_id = socket.user.id;

      const { rows } = await pool.query(
        `INSERT INTO messaggi (
          corsa_id,
          cliente_id,
          sender_id,
          testo,
          client_msg_id,
          read_status
        )
        VALUES ($1,$2,$3,$4,$5,
          CASE
            WHEN $3 = (SELECT driver_id FROM veicolo v
                       JOIN corse c ON c.veicolo_id = v.id
                       WHERE c.id = $1)
            THEN '{"autista": true, "cliente": false}'
            ELSE '{"autista": false, "cliente": true}'
          END
        )
        ON CONFLICT (client_msg_id) DO NOTHING
        RETURNING *`,
        [corsa_id, cliente_id, sender_id, text.trim(), client_msg_id]
      );

      if (!rows.length) return;

      io.to(`chat_${corsa_id}_${cliente_id}`).emit("new_message", rows[0]);
    });
  });
};

export default chatRouter;