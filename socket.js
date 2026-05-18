import jwt from "jsonwebtoken";
import { pool } from "./db/db.js";
import crypto from "crypto";

let io;

/* ================= IO ================= */

export const getIO = () => {
  if (!io) throw new Error("Socket.io non inizializzato!");
  return io;
};

/* ================= NOTIFICATION ================= */

export const sendNotification = ({ userId, role, notification }) => {
  if (!io) return;
  if (!userId || !role || !notification) return;

  const room = `${role}_${userId}`;

  console.log("🔔 [NOTIF] SEND →", room, notification);

  io.to(room).emit("new_notification", {
    ...notification,
    sentAt: Date.now(),
  });
};

/* ================= SOCKET SETUP ================= */

export const setupSocket = (ioServer) => {
  io = ioServer;

  const JWT_SECRET = process.env.JWT_SECRET || "segreto-di-test";

  /* ================= AUTH ================= */

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;

    console.log("🔐 AUTH TOKEN:", token ? "OK" : "MISSING");

    if (!token) return next(new Error("NO_TOKEN"));

    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      decoded.role = decoded.role?.toLowerCase() || "cliente";
      socket.user = decoded;

      console.log("🟢 AUTH OK:", decoded);

      next();
    } catch (err) {
      console.log("❌ JWT INVALID:", err.message);
      return next(new Error("JWT_INVALID"));
    }
  });

  /* ================= CONNECTION ================= */

  io.on("connection", (socket) => {
    const { id: userId, role } = socket.user;

    console.log("🟢 SOCKET CONNECTED:", {
      socketId: socket.id