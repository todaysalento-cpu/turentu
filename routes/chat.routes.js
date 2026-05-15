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
    next();
  } catch {
    return res.status(401).json({ message: "Invalid token" });
  }
};

/* ================= INIT THREADS ================= */
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

    const threads = rows.map((t) => ({
      id: `${t.corsa_id}_${t.cliente_id}`,
      corsa_id: t.corsa_id,
      cliente_id: t.cliente_id,
      driver_id: t.driver_id,
      last_message: t.last_message,
      unreadCount: t.unreadcount ?? 0,
      updated_at: new Date(t.updated_at).getTime(),
    }));

    res.json(threads);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "init error" });
  }
});

/* ================= MESSAGES (MANCAVA TUTTO) ================= */
chatRouter.get("/messages", authMiddleware, async (req, res) => {
  const { corsa_id, cliente_id } = req.query;

  if (!corsa_id || !cliente_id) {
    return res.status(400).json({ message: "missing params" });
  }

  try {
    const { rows } = await pool.query(
      `
      SELECT *
      FROM messaggi
      WHERE corsa_id = $1 AND cliente_id = $2
      ORDER BY created_at ASC
      `,
      [corsa_id, cliente_id]
    );

    res.json({ messages: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "messages error" });
  }
});

export default chatRouter;