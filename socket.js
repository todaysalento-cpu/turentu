// ======================= socket.js =======================
import jwt from 'jsonwebtoken';
import { pool } from './db/db.js';
import { getCorseCache } from './services/search/search.cache.js';

let io;

// =======================
// Getter io
// =======================
const getIO = () => {
  if (!io) throw new Error('Socket.io non inizializzato!');
  return io;
};

// =======================
// EMIT HELPERS (🔥 USALI NEI SERVICE)
// =======================

// 👉 nuova corsa (FONDAMENTALE per il tuo bug)
const emitNuovaCorsa = (driverId, corsa) => {
  if (!io) return;
  console.log('🚀 EMIT nuova_corsa -> autista', driverId, corsa.id);

  io.to(`autista_${driverId}`).emit('nuova_corsa', corsa);

  // join automatico alla room corsa
  io.in(`autista_${driverId}`).socketsJoin(`corsa_${corsa.id}`);
};

// 👉 update corsa
const emitCorsaUpdate = (corsa) => {
  if (!io) return;
  console.log('🔄 EMIT corsaUpdate', corsa.id);

  io.to(`corsa_${corsa.id}`).emit('corsaUpdate', corsa);
};

// 👉 pending update
const emitPendingUpdate = (driverId, pending) => {
  if (!io) return;
  console.log('📦 EMIT pending_update', pending.id);

  io.to(`autista_${driverId}`).emit('pending_update', pending);
};

// 👉 nuova richiesta pending
const emitNewPending = (driverId, pending) => {
  if (!io) return;
  console.log('🆕 EMIT new_pending', pending.id);

  io.to(`autista_${driverId}`).emit('new_pending', { pending });
};

// 👉 notifiche
const sendNotification = ({ userId, role, notification }) => {
  if (!io) throw new Error('Socket.io non inizializzato!');
  if (!notification || !userId || !role) return;

  io.to(`${role}_${userId}`).emit('new_notification', notification);
};

// =======================
// Setup Socket.IO
// =======================
const setupSocket = (ioServer) => {
  io = ioServer;

  const JWT_SECRET = process.env.JWT_SECRET || 'segreto-di-test';
  const isDev = process.env.NODE_ENV !== 'production';

  // =======================
  // AUTH
  // =======================
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Authentication error'));

    try {
      const decoded = jwt.verify(token, JWT_SECRET);

      decoded.role = ['autista', 'cliente'].includes(decoded.role?.toLowerCase())
        ? decoded.role.toLowerCase()
        : 'cliente';

      socket.user = decoded;
      next();
    } catch (err) {
      console.error('❌ Socket auth error:', err.message);
      return next(new Error('Authentication error'));
    }
  });

  // =======================
  // CONNECTION
  // =======================
  io.on('connection', async (socket) => {
    const { id: userId, role } = socket.user;
    const joinedRooms = new Set();

    if (isDev) console.log('🔌 Client connesso:', socket.id, socket.user);

    // =======================
    // ROOM PERSONALE
    // =======================
    const personalRoom = `${role}_${userId}`;
    socket.join(personalRoom);
    joinedRooms.add(personalRoom);

    // =======================
    // AUTISTA → JOIN CORSE
    // =======================
    if (role === 'autista') {
      try {
        const corseCache = await getCorseCache();

        // 🔥 FIX: usa driver_id NON veicolo_id
        const corse = corseCache.filter(c => c.driver_id === userId);

        if (isDev) console.log(`🚗 Autista ha ${corse.length} corse`);

        for (const corsa of corse) {
          const room = `corsa_${corsa.id}`;
          if (!joinedRooms.has(room)) {
            socket.join(room);
            joinedRooms.add(room);

            if (isDev) console.log(`✈️ Join corsa room: ${room}`);
          }
        }
      } catch (err) {
        console.error('❌ Errore join corse autista:', err);
      }
    }

    // =======================
    // JOIN CHAT
    // =======================
    socket.on('join_chat', async ({ corsa_id, cliente_id }) => {
      const corsaIdNum = Number(corsa_id);
      const clienteIdNum = Number(cliente_id);
      if (isNaN(corsaIdNum) || isNaN(clienteIdNum)) return;

      const room = `chat_${corsaIdNum}_${clienteIdNum}`;

      if (!joinedRooms.has(room)) {
        socket.join(room);
        joinedRooms.add(room);
      }

      try {
        // MESSAGGI
        const { rows } = await pool.query(
          `SELECT id, corsa_id, cliente_id, sender_id,
                  testo AS text,
                  created_at AS timestamp,
                  read_status
           FROM messaggi
           WHERE corsa_id=$1 AND cliente_id=$2
           ORDER BY created_at ASC`,
          [corsaIdNum, clienteIdNum]
        );

        const messages = rows.map(r => ({
          id: r.id,
          corsa_id: Number(r.corsa_id),
          cliente_id: Number(r.cliente_id),
          sender_id: r.sender_id,
          role: r.sender_id === userId ? role : role === 'autista' ? 'cliente' : 'autista',
          text: r.text,
          timestamp: r.timestamp,
          read_status: typeof r.read_status === 'string'
            ? JSON.parse(r.read_status)
            : r.read_status || { autista: false, cliente: false }
        }));

        socket.emit('init_chat', {
          corsa_id: corsaIdNum,
          cliente_id: clienteIdNum,
          messages,
          lastMessageTime: messages.length
            ? messages[messages.length - 1].timestamp
            : new Date().toISOString()
        });

      } catch (err) {
        console.error('❌ join_chat error:', err);
      }
    });

    // =======================
    // SEND MESSAGE
    // =======================
    socket.on('send_message', async ({ corsa_id, cliente_id, text }) => {
      if (!text?.trim()) return;

      const room = `chat_${corsa_id}_${cliente_id}`;

      try {
        const { rows } = await pool.query(
          `INSERT INTO messaggi
           (corsa_id, cliente_id, sender_id, testo, created_at, read_status)
           VALUES ($1,$2,$3,$4,$5,$6)
           RETURNING id, testo AS text, created_at AS timestamp`,
          [corsa_id, cliente_id, userId, text.trim(), new Date(), '{}']
        );

        io.to(room).emit('new_message', {
          ...rows[0],
          corsa_id,
          cliente_id,
          sender_id: userId,
          role
        });

      } catch (err) {
        console.error('❌ send_message error:', err);
      }
    });

    // =======================
    // DISCONNECT
    // =======================
    socket.on('disconnect', (reason) => {
      if (isDev) console.log('❌ Disconnesso:', socket.id, reason);
    });
  });
};

// =======================
export {
  setupSocket,
  getIO,
  sendNotification,
  emitNuovaCorsa,
  emitCorsaUpdate,
  emitPendingUpdate,
  emitNewPending
};