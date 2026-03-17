// socket-test-server.js (ESM)
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

io.on('connection', (socket) => {
  console.log('Nuovo client connesso', socket.id);

  socket.on('test', (data) => {
    console.log('Test message ricevuto dal client:', data);
    socket.emit('test', { message: 'Ricevuto dal server!', clientData: data });
  });

  socket.on('disconnect', () => {
    console.log('Client disconnesso', socket.id);
  });
});

server.listen(3002, () => {
  console.log('Socket test server running on port 3002');
});