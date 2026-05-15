import express from "express";
import { pool } from "../db/db.js";
import jwt from "jsonwebtoken";

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

    console.log("🟢 AUTH OK:", {
      userId: decoded.id,
      role: decoded.role,
    });

    next();
  } catch (err) {
    console.error("🔴 AUTH ERROR:", err.message);
    return res.status(401).json({ message: "Invalid token" });
  }
};

/* ================= INIT THREADS ================= */
chatRouter.get("/init", authMiddleware, async (req, res) => {
  const userId = Number(req.user.id);
  const role = req.user.role;

  console.log("📡 /chat/init HIT:", { userId, role });

  try {
    const query =
      role === "autista"
        ? `SELECT * FROM chat_threads WHERE driver_id=$1 ORDER BY updated_at DESC`
        : `SELECT * FROM chat_threads WHERE cliente_id=$1 ORDER BY updated_at DESC`;

    console.log("🧠 THREAD QUERY:", query);

    const { rows } = await pool.query(query, [userId]);

    console.log("📦 RAW THREADS:", rows.length);

    const threads = rows.map((t) => {
      const last = t.last_message || {};

      return {
        id: `${t.corsa_id}_${t.cliente_id}`,
        corsa_id: Number(t.corsa_id),
        cliente_id: Number(t.cliente_id),
        driver_id: Number(t.driver_id),

        last_message: {
          text: last?.text ?? "",
          created_at: last?.created_at ?? null,
        },

        unreadCount: Number(t.unreadcount ?? t.unread_count ?? 0),
        updated_at: new Date(t.updated_at).getTime(),
      };
    });

    console.log("✅ THREADS RESPONSE:", threads.length);

    res.json(threads);
  } catch (err) {
    console.error("❌ INIT ERROR:", err);
    res.status(500).json({ message: "init error" });
  }
});

/* ================= MESSAGES ================= */
chatRouter.get("/messages", authMiddleware, async (req, res) => {
  const corsa_id = Number(req.query.corsa_id);
  const cliente_id = Number(req.query.cliente_id);

  console.log("📩 /messages HIT:", { corsa_id, cliente_id });

  if (!corsa_id || !cliente_id) {
    console.warn("⚠️ MISSING PARAMS");
    return res.status(400).json({ message: "missing params" });
  }

  try {
    const query = `
      SELECT *
      FROM messaggi
      WHERE corsa_id = $1 AND cliente_id = $2
      ORDER BY created_at ASC
    `;

    console.log("🧠 MESSAGES QUERY:", query);

    const { rows } = await pool.query(query, [corsa_id, cliente_id]);

    console.log("📦 RAW MESSAGES:", rows.length);

    const formatted = rows.map((m) => ({
      id: m.id,
      client_msg_id: m.client_msg_id,
      corsa_id: m.corsa_id,
      cliente_id: m.cliente_id,
      sender_id: m.sender_id,
      text: m.testo,
      created_at: Number(m.created_at),
    }));

    console.log("✅ MESSAGES RESPONSE:", formatted.length);

    res.json({ messages: formatted });
  } catch (err) {
    console.error("❌ MESSAGES ERROR:", err);
    res.status(500).json({ message: "messages error" });
  }
});

export default chatRouter;