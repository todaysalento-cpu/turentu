// tests/test_chat_dual_client.js
import { io } from 'socket.io-client';
import jwt from 'jsonwebtoken';

const SERVER_URL = 'http://localhost:3001';
const JWT_SECRET = process.env.JWT_SECRET || 'segreto-di-test';
const CORSA_ID = 1;

// =================== CREA TOKEN ===================
const createToken = (id, role) => {
  return jwt.sign({ id, role }, JWT_SECRET, { expiresIn: '1h' });
};

// =================== CLIENT ===================
const setupClient = (id, role) => {
  const token = createToken(id, role);
  const socket = io(SERVER_URL, {
    auth: { token },
  });

  socket.on('connect', () => {
    console.log(`🟢 ${role} connesso:`, socket.id);
    socket.emit('join_corsa_chat', CORSA_ID);
  });

  socket.on('new_message', (msg) => {
    console.log(`📨 ${role} ha ricevuto messaggio:`, msg);
  });

  socket.on('unread_count', ({ corsa_id, count }) => {
    console.log(`📊 ${role} messaggi non letti per corsa_${corsa_id}: ${count}`);
  });

  return socket;
};

// =================== AVVIO CLIENT ===================
const cliente = setupClient(1, 'Cliente');
const autista = setupClient(2, 'autista');

// =================== INVIO MESSAGGI DI TEST ===================
setTimeout(() => {
  cliente.emit('send_message', { corsa_id: CORSA_ID, text: 'Ciao Autista!' });
  console.log('📤 Cliente invia: Ciao Autista!');
}, 1000);

setTimeout(() => {
  autista.emit('send_message', { corsa_id: CORSA_ID, text: 'Ciao Cliente, ricevuto!' });
  console.log('📤 Autista invia: Ciao Cliente, ricevuto!');
}, 2000);

// =================== CHIUSURA AUTOMATICA ===================
setTimeout(() => {
  cliente.disconnect();
  autista.disconnect();
  console.log('🔴 Test completato, client disconnessi');
}, 5000);