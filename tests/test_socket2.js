import { io } from 'socket.io-client';

const API_URL = 'http://localhost:3001';
const TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6Miwicm9sZSI6ImF1dGlzdGEiLCJlbWFpbCI6Im1hcmlvLnJvc3NpQGV4YW1wbGUuY29tIiwibm9tZSI6Ik1hcmlvIFJvc3NpIiwiaWF0IjoxNzczNjA0Nzc4LCJleHAiOjE3NzQyMDk1Nzh9.FND63i6TwP15yn7qR4pAB9M2vN6kQndsstx5EVfncAo';

const socket = io(API_URL, {
  auth: { token: TOKEN },
  transports: ['websocket'],
});

socket.on('connect', () => {
  console.log('🟢 Connesso al socket!', socket.id);
});

socket.on('connect_error', (err) => {
  console.error('❌ Socket auth error:', err.message);
});

socket.on('new_message', (msg) => {
  console.log('📩 Nuovo messaggio:', msg);
});

socket.on('disconnect', () => {
  console.log('⚪ Disconnesso dal socket');
});