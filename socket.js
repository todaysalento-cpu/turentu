// ======================= socket.js =======================
import jwt from 'jsonwebtoken';
import { pool } from './db/db.js';
import { getCorseCache } from './services/search/search.cache.js';

let io;

// =======================
// Funzione pubblica per notifiche
// =======================
const sendNotification = ({ userId, role, notification }) => {
  if (!io) throw new Error('Socket.io non inizializzato!');
  if (!notification || !userId || !role) return;

  console.log(`📣 Invio notifica a ${role}_${userId}:`, notification);
  io.to(`${role}_${userId}`).emit('new_notification', notification);
};

// =======================
// Getter io
// =======================
const getIO = () => {
  if (!io) throw new Error('Socket.io non inizializzato!');
  return io;
};

// =======================
// Setup Socket.IO
// =======================
const setupSocket = (ioServer) => {
  io = ioServer;
  const JWT_SECRET = process.env.JWT_SECRET || 'segreto-di-test';
  const isDev = process.env.NODE_ENV !== 'production';

  // ===== AUTH =====
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

    // Room personale
    const personalRoom = `${role}_${userId}`;
    socket.join(personalRoom);
    joinedRooms.add(personalRoom);

    if (isDev) console.log('🔌 Client connesso:', socket.id, socket.user);

    // =======================
    // AUTISTA JOIN CORSE
    // =======================
    if (role === 'autista') {
      try {
        const corseCache = await getCorseCache();
        const corse = corseCache.filter(c => c.veicolo_id === userId);

        if (isDev) console.log(`🚗 Autista ha ${corse.length} corse`);

        for (const corsa of corse) {
          const corsaRoom = `corsa_${corsa.id}`;
          if (!joinedRooms.has(corsaRoom)) {
            socket.join(corsaRoom);
            joinedRooms.add(corsaRoom);
            if (isDev) console.log(`✈️ Autista join corsa room: ${corsaRoom}`);
          }
        }
      } catch (err) {
        console.error('❌ Errore join corsa autista:', err);
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
        if (isDev) console.log(`🟢 Join chat room: ${room}`);
      }

      try {
        // =======================
        // MESSAGGI
        // =======================
        const { rows: messagesRows } = await pool.query(
          `SELECT id, corsa_id, cliente_id, sender_id, testo AS text, created_at AS timestamp, read_status
           FROM messaggi
           WHERE corsa_id=$1 AND cliente_id=$2
           ORDER BY created_at ASC`,
          [corsaIdNum, clienteIdNum]
        );

        const messages = messagesRows.map(r => ({
          id: r.id,
          corsa_id: Number(r.corsa_id),
          cliente_id: Number(r.cliente_id),
          sender_id: r.sender_id,
          sender_name: r.sender_id === userId ? role : role === 'autista' ? 'cliente' : 'autista',
          role: r.sender_id === userId ? role : role === 'autista' ? 'cliente' : 'autista',
          text: r.text,
          timestamp: r.timestamp,
          read_status: typeof r.read_status === 'string'
            ? JSON.parse(r.read_status)
            : r.read_status || { autista: false, cliente: false }
        }));

        // =======================
        // PARTECIPANTI
        // =======================
        const { rows: participants } = await pool.query(
          `SELECT u.id, u.nome, 'cliente' AS role
           FROM utente u
           JOIN prenotazioni p ON p.cliente_id = u.id
           WHERE p.corsa_id = $1
           UNION
           SELECT u.id, u.nome, 'autista' AS role
           FROM veicolo v
           JOIN corse c ON c.veicolo_id = v.id
           JOIN utente u ON u.id = v.driver_id
           WHERE c.id = $1`,
          [corsaIdNum]
        );

        // =======================
        // INIT CHAT
        // =======================
        socket.emit('init_chat', {
          corsa_id: corsaIdNum,
          cliente_id: clienteIdNum,
          messages: messages || [],
          participants,
          lastMessageTime: messages.length ? messages[messages.length - 1].timestamp : new Date().toISOString()
        });

        // =======================
        // Aggiorna messaggi letti
        // =======================
        if (messages.length > 0) {
          await pool.query(
            `UPDATE messaggi
             SET read_status = jsonb_set(read_status, $1, 'true'::jsonb)
             WHERE corsa_id=$2 AND cliente_id=$3 AND sender_id != $4`,
            [`{${role}}`, corsaIdNum, clienteIdNum, userId]
          );

          const { rows: unreadRows } = await pool.query(
            `SELECT COUNT(*) AS count
             FROM messaggi
             WHERE corsa_id=$1 AND cliente_id=$2 AND sender_id != $3 AND NOT (read_status->>$4)::boolean`,
            [corsaIdNum, clienteIdNum, userId, role]
          );

          io.to(room).emit('unread_count', {
            corsa_id: corsaIdNum,
            cliente_id: clienteIdNum,
            count: parseInt(unreadRows[0].count, 10)
          });
        }
      } catch (err) {
        console.error('❌ join_chat error:', err);
      }
    });

    // =======================
    // SEND MESSAGE
    // =======================
    socket.on('send_message', async ({ corsa_id, cliente_id, text }) => {
      if (!text?.trim()) return;

      const corsaIdNum = Number(corsa_id);
      const clienteIdNum = Number(cliente_id);
      if (isNaN(corsaIdNum) || isNaN(clienteIdNum)) return;

      const room = `chat_${corsaIdNum}_${clienteIdNum}`;
      const readStatus = { autista: role === 'autista', cliente: role === 'cliente' };

      try {
        const { rows } = await pool.query(
          `INSERT INTO messaggi
           (corsa_id, cliente_id, sender_id, testo, created_at, read_status)
           VALUES ($1,$2,$3,$4,$5,$6)
           RETURNING id, corsa_id, cliente_id, sender_id, testo AS text, created_at AS timestamp, read_status`,
          [corsaIdNum, clienteIdNum, userId, text.trim(), new Date(), JSON.stringify(readStatus)]
        );

        const msg = rows[0];
        if (isDev) console.log("📡 Broadcast new_message");

        io.to(room).emit('new_message', {
          id: msg.id,
          corsa_id: corsaIdNum,
          cliente_id: clienteIdNum,
          sender_id: msg.sender_id,
          sender_name: role,
          role,
          text: msg.text,
          timestamp: msg.timestamp,
          read_status: msg.read_status
        });
      } catch (err) {
        console.error('❌ send_message error:', err);
      }
    });

    // =======================
    // DISCONNECT
    // =======================
    socket.on('disconnect', (reason) => {
      if (isDev) console.log('❌ Client disconnesso:', socket.id, '| reason:', reason);
    });
  });
};

export { io, setupSocket, sendNotification, getIO };