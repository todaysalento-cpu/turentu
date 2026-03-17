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

  // ===== AUTH =====
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Authentication error'));

    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      decoded.role = decoded.role.toLowerCase();
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

    console.log('🔌 Client connesso:', socket.id);
    console.log('👤 Utente:', socket.user);

    // =======================
    // AUTISTA JOIN CORSE
    // =======================
    if (role === 'autista') {
      try {
        // Leggi corse attive direttamente dalla cache (Redis se disponibile)
        const corseCache = await getCorseCache();
        const corse = corseCache.filter(c => c.veicolo_id === userId); // esempio mapping driver -> veicolo

        console.log(`🚗 Autista ha ${corse.length} corse`);

        for (const corsa of corse) {
          const corsaRoom = `corsa_${corsa.id}`;
          if (!joinedRooms.has(corsaRoom)) {
            socket.join(corsaRoom);
            joinedRooms.add(corsaRoom);
            console.log(`✈️ Autista join corsa room: ${corsaRoom}`);
          }
        }
      } catch (err) {
        console.error('Errore join corsa autista:', err);
      }
    }

    // =======================
    // JOIN CHAT
    // =======================
    socket.on('join_chat', async ({ corsa_id, cliente_id }) => {
      corsa_id = Number(corsa_id);
      cliente_id = Number(cliente_id);

      const room = `chat_${corsa_id}_${cliente_id}`;
      if (!joinedRooms.has(room)) {
        socket.join(room);
        joinedRooms.add(room);
        console.log(`🟢 Join chat room: ${room}`);
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
          [corsa_id, cliente_id]
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
          [corsa_id]
        );

        // =======================
        // INIT CHAT
        // =======================
        socket.emit('init_chat', {
          corsa_id,
          cliente_id,
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
            [`{${role}}`, corsa_id, cliente_id, userId]
          );

          const { rows: unreadRows } = await pool.query(
            `SELECT COUNT(*) AS count
             FROM messaggi
             WHERE corsa_id=$1 AND cliente_id=$2 AND sender_id != $3 AND NOT (read_status->>$4)::boolean`,
            [corsa_id, cliente_id, userId, role]
          );

          io.to(room).emit('unread_count', {
            corsa_id,
            cliente_id,
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

      corsa_id = Number(corsa_id);
      cliente_id = Number(cliente_id);
      const room = `chat_${corsa_id}_${cliente_id}`;
      const readStatus = { autista: role === 'autista', cliente: role === 'cliente' };

      try {
        const { rows } = await pool.query(
          `INSERT INTO messaggi
           (corsa_id, cliente_id, sender_id, testo, created_at, read_status)
           VALUES ($1,$2,$3,$4,$5,$6)
           RETURNING id, corsa_id, cliente_id, sender_id, testo AS text, created_at AS timestamp, read_status`,
          [corsa_id, cliente_id, userId, text.trim(), new Date(), JSON.stringify(readStatus)]
        );

        const msg = rows[0];
        console.log("📡 Broadcast new_message");

        io.to(room).emit('new_message', {
          id: msg.id,
          corsa_id: Number(msg.corsa_id),
          cliente_id: Number(msg.cliente_id),
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

    socket.on('disconnect', (reason) => {
      console.log('❌ Client disconnesso:', socket.id, '| reason:', reason);
    });
  });
};

export { io, setupSocket, sendNotification, getIO };