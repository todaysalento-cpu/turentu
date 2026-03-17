import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';

const app = express();
const PORT = 3001;
const JWT_SECRET = 'segreto-di-test';

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: 'http://localhost:3000', methods: ['GET', 'POST'], credentials: true }
});

// Middleware JWT per socket
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  console.log('🔑 Token ricevuto:', token);
  if (!token) return next(new Error('No token'));

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    socket.user = decoded;
    next();
  } catch (err) {
    console.error('❌ Token invalido:', err.message);
    return next(new Error('Invalid token'));
  }
});

// Connessione
io.on('connection', (socket) => {
  console.log('🟢 Client connesso:', socket.id, '| user:', socket.user);

  // Join room test
  socket.on('join_corsa_chat', (corsaId) => {
    const room = `corsa_${corsaId}`;
    socket.join(room);
    console.log(`🔵 Socket ${socket.id} unito alla stanza ${room}`);
  });

  // Ricezione messaggi
  socket.on('send_message', ({ corsa_id, text }) => {
    console.log('📨 Messaggio ricevuto:', text, '| corsa_id:', corsa_id, '| socket:', socket.id);
    io.to(`corsa_${corsa_id}`).emit('new_message', { corsa_id, text, user: socket.user.role });
  });

  socket.on('disconnect', () => {
    console.log('🔴 Client disconnesso:', socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Server test Socket.io avviato su http://localhost:${PORT}`);
});