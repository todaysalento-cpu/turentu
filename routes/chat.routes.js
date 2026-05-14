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

/* ======================= THREAD LIST ======================= */
chatRouter.get("/init", authMiddleware, async (req, res) => {
  const userId = Number(req.user.id);
  const role = req.user.role;
  const LIMIT = 30;

  try {
    let rows;

    if (role === "autista") {
      const r = await pool.query(
        `
        SELECT DISTINCT
          c.id AS corsa_id,
          p.cliente_id,
          c.origine_address,
          c.destinazione_address,
          c.start_datetime
        FROM corse c
        JOIN veicolo v ON v.id = c.veicolo_id
        JOIN prenotazioni p ON p.corsa_id = c.id
        WHERE v.driver_id = $1
        ORDER BY c.start_datetime DESC
        `,
        [userId]
      );

      rows = r.rows;
    } else {
      const r = await pool.query(
        `
        SELECT DISTINCT
          c.id AS corsa_id,
          p.cliente_id,
          c.origine_address,
          c.destinazione_address,
          c.start_datetime
        FROM prenotazioni p
        JOIN corse c ON c.id = p.corsa_id
        WHERE p.cliente_id = $1
        ORDER BY c.start_datetime DESC
        `,
        [userId]
      );

      rows = r.rows;
    }

    const threads = await Promise.all(
      rows.map(async (r) => {
        const corsaId = r.corsa_id;
        const clienteId = r.cliente_id;

        /* ===================== UNREAD COERENTE CON SOCKET ===================== */
        const unread = await pool.query(
          `
          SELECT COUNT(*)::int AS count
          FROM messaggi
          WHERE corsa_id = $1
            AND cliente_id = $2
            AND sender_id != $3
            AND (read_status->>'cliente')::boolean = false
          `,
          [corsaId, clienteId, userId]
        );

        /* ===================== MESSAGES ===================== */
        const messages = await pool.query(
          `
          SELECT
            id,
            corsa_id,
            cliente_id,
            sender_id,
            testo AS text,
            created_at,
            read_status,
            client_msg_id
          FROM messaggi
          WHERE corsa_id = $1
            AND cliente_id = $2
          ORDER BY created_at DESC
          LIMIT $3
          `,
          [corsaId, clienteId, LIMIT]
        );

        return {
          id: `${corsaId}_${clienteId}`,
          corsa_id: corsaId,
          cliente_id: clienteId,
          origine: r.origine_address,
          destinazione: r.destinazione_address,
          start_datetime: r.start_datetime,
          unreadCount: unread.rows[0]?.count || 0,
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
      `
      SELECT
        id,
        corsa_id,
        cliente_id,
        sender_id,
        testo AS text,
        created_at,
        read_status,
        client_msg_id
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
      messages: rows.reverse(),
      hasMore: rows.length === Number(limit),
      nextCursor: rows[0]?.created_at
        ? new Date(rows[0].created_at).getTime()
        : null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "pagination error" });
  }
});

/* ======================= SEND (HTTP FALLBACK) ======================= */
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
        read_status
      )
      VALUES (
        $1,$2,$3,$4,$5,
        '{"autista": false, "cliente": false}'::jsonb
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
        client_msg_id
      `,
      [corsa_id, cliente_id, sender_id, text.trim(), client_msg_id]
    );

    if (!rows.length) {
      return res.json({ ok: true, duplicate: true });
    }

    return res.json({ ok: true, message: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "send error" });
  }
});

export default chatRouter;