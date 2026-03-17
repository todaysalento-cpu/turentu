// ======================= ws-server.js =======================
import { createServer } from 'http';
import { Server } from 'socket.io';
import 'dotenv/config';

import { setupSocket } from './socket.js';

// =======================
// HTTP SERVER (no Express)
// =======================
const httpServer = createServer();

// =======================
// SOCKET.IO SETUP
// =======================
const io = new Server(httpServer, {
  cors: {
    origin: [
      'http://localhost:3000',
      'http://localhost:5173',
      process.env.FRONTEND_URL
    ].filter(Boolean),
    credentials: true
  },
  transports: ['websocket', 'polling'] // fallback support
});

// =======================
// INIT SOCKET LOGIC
// =======================
setupSocket(io);

// =======================
// HEALTH CHECK (utile)
// =======================
httpServer.on('request', (req, res) => {
  if (req.url === '/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'pong',
      service: 'TURENTU WS Server',
      timestamp: new Date().toISOString()
    }));
  }
});

// =======================
// START SERVER
// =======================
const PORT = process.env.WS_PORT || 3001;

httpServer.listen(PORT, () => {
  console.log(`🚀 WebSocket server running on port ${PORT}`);
});