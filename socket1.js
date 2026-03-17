// ======================= socket.js =======================
import jwt from 'jsonwebtoken';
import { pool } from './db/db.js';

let io; // Reference globale a Socket.IO

// ===== Funzione pubblica per inviare notifiche =====
const sendNotification = ({ userId, role, notification }) => {
  if (!io) throw new Error('Socket.io non inizializzato!');
  if (!notification || !userId || !role) return;

  console.log(`📣 Invio notifica a ${role}_${userId}:`, notification);
  io.to(`${role}_${userId}`).emit('new_notification', notification);
};

// ===== Setup Socket.IO =====
const setupSocket = (ioServer) => {
  io = ioServer;
  const JWT_SECRET = process.env.JWT_SECRET || 'segreto-di-test';

  // Middleware autenticazione
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Authentication error: No token'));

    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      decoded.role = decoded.role.toLowerCase();
      socket.user = decoded;
      next();
    } catch (err) {
      return next(new Error('Authentication error: Invalid token'));
    }
  });

  io.on('connection', async (socket) => {
    const { id: userId, role } = socket.user;
    const personalRoom = `${role}_${userId}`;

    console.log('🔌 Nuovo client connesso:', socket.id);
    console.log('📝 Dati utente:', socket.user);

    // Join alla propria room personale
    socket.join(personalRoom);
    console.log(`🏠 Utente ${role} joined personal room: ${personalRoom}`);
    console.log('💡 Rooms attuali del socket:', Array.from(socket.rooms));

    // Join automatico corse per autista
    if (role === 'autista') {
      try {
        const { rows } = await pool.query(
          `SELECT c.id, c.origine, c.destinazione 
           FROM corse c
           JOIN veicolo v ON v.id = c.veicolo_id
           WHERE v.driver_id = $1`,
          [userId]
        );

        rows.forEach(corsa => {
          socket.join(`corsa_${corsa.id}`);
          console.log(`🚗 Autista joined room corsa_${corsa.id}`);
        });

        console.log('💡 Rooms dopo join automatico:', Array.from(socket.rooms));
      } catch (err) {
        console.error('Errore join automatico corse autista:', err.message);
      }
    }

    // ===== CHAT EVENTS =====
    socket.on('join_corsa_chat', async (corsaId) => {
      const room = `corsa_${corsaId}`;
      socket.join(room);
      console.log(`✉️ Utente ${userId} joined corsa_${corsaId} room`);

      try {
        // Recupera cronologia messaggi
        const { rows } = await pool.query(
          `SELECT id, corsa_id, sender_id, testo AS text, created_at AS timestamp, read_status
           FROM messaggi 
           WHERE corsa_id=$1 
           ORDER BY created_at ASC`,
          [corsaId]
        );

        const messages = rows.map(r => ({
          id: r.id,
          corsa_id: Number(r.corsa_id),
          sender_id: r.sender_id,
          user: r.sender_id === userId ? role : (role === 'autista' ? 'cliente' : 'autista'),
          text: r.text,
          timestamp: r.timestamp,
          read_status: typeof r.read_status === 'string' ? JSON.parse(r.read_status) : r.read_status || { autista: false, cliente: false }
        }));

        socket.emit(`init_chat_${corsaId}`, messages);
        console.log(`📤 Messaggi inviati per corsa_${corsaId}`);

        // Aggiorna messaggi come letti per ruolo corrente
        await pool.query(
          `UPDATE messaggi
           SET read_status = jsonb_set(read_status, $1, 'true'::jsonb)
           WHERE corsa_id=$2 AND NOT (read_status->>$3)::boolean`,
          [`{${role}}`, corsaId, role]
        );

        // Invia conteggio messaggi non letti
        const unreadRes = await pool.query(
          `SELECT COUNT(*) AS unread 
           FROM messaggi 
           WHERE corsa_id=$1 AND sender_id != $2 AND NOT (read_status->>$3)::boolean`,
          [corsaId, userId, role]
        );
        const unreadCount = parseInt(unreadRes.rows[0].unread, 10);
        io.to(room).emit('unread_count', { corsa_id: corsaId, count: unreadCount });

      } catch (err) {
        console.error('join_corsa_chat error:', err.message);
      }
    });

    socket.on('send_message', async ({ corsa_id, text }) => {
      if (!text?.trim()) return;

      const readStatus = { autista: role === 'autista', cliente: role === 'cliente' };

      try {
        const { rows } = await pool.query(
          `INSERT INTO messaggi (corsa_id, sender_id, testo, created_at, read_status)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, corsa_id, sender_id, testo AS text, created_at AS timestamp, read_status`,
          [corsa_id, userId, text.trim(), new Date(), JSON.stringify(readStatus)]
        );

        const msg = rows[0];

        io.to(`corsa_${corsa_id}`).emit('new_message', {
          id: msg.id,
          corsa_id: Number(msg.corsa_id),
          sender_id: msg.sender_id,
          user: role,
          text: msg.text,
          timestamp: msg.timestamp,
          read_status: typeof msg.read_status === 'string' ? JSON.parse(msg.read_status) : msg.read_status
        });

        // Aggiorna conteggio non letti
        const unreadRes = await pool.query(
          `SELECT COUNT(*) AS unread 
           FROM messaggi 
           WHERE corsa_id=$1 AND sender_id != $2 AND NOT (read_status->>$3)::boolean`,
          [corsa_id, userId, role]
        );
        const unreadCount = parseInt(unreadRes.rows[0].unread, 10);
        io.to(`corsa_${corsa_id}`).emit('unread_count', { corsa_id, count: unreadCount });

      } catch (err) {
        console.error('send_message error:', err.message);
      }
    });

    socket.on('disconnect', (reason) => {
      console.log('❌ Client disconnesso:', socket.id, '| reason:', reason);
      console.log('💡 Rooms finali del socket:', Array.from(socket.rooms));
    });

  }); // fine connection
};

// ===== EXPORT =====
export { io, setupSocket, sendNotification };