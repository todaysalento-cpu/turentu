import { fetch, FormData, Headers } from 'undici';
import { io } from 'socket.io-client';

const USER_EMAIL = 'mario.rossi@example.com';
const USER_PASSWORD = 'PasswordCliente123';
const SOCKET_URL = 'http://localhost:3001';

let cookies = '';

async function login() {
  const res = await fetch('http://localhost:3001/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: USER_EMAIL, password: USER_PASSWORD }),
  });

  const data = await res.json();
  console.log('Login:', data);

  // salva cookie di sessione
  const rawCookies = res.headers.get('set-cookie');
  if (rawCookies) cookies = rawCookies;
  return data.user?.id || data.id;
}

async function authFetch(url, options = {}) {
  options.headers = options.headers || {};
  options.headers.Cookie = cookies; // invia il cookie
  return fetch(url, options);
}

// Esempio fetch veicoli
async function testVeicoli(userId) {
  console.log('--- TEST VEICOLI ---');
  const res = await authFetch(`http://localhost:3001/disponibilita/?today=true&driver_id=${userId}`);
  const data = await res.json();
  console.log('Veicoli:', data);
}

// Stesso schema per pending, corse, accetta corsa
async function testPending(userId) {
  const res = await authFetch(`http://localhost:3001/pending/autista/${userId}`);
  const data = await res.json();
  console.log('Pending:', data);
  return data;
}

async function testAccettaCorsa(pendingId) {
  const res = await authFetch(`http://localhost:3001/pending/${pendingId}/accetta`, { method: 'POST' });
  const data = await res.json();
  console.log(`Corsa ${pendingId} accettata:`, data);
}

async function testCorseGiornata(userId) {
  const res = await authFetch(`http://localhost:3001/corse/autista/today/${userId}`);
  const data = await res.json();
  console.log('Corse giornata:', data);
}

// Socket rimane uguale
function testSocket(userId) {
  const socket = io(SOCKET_URL, { withCredentials: true });
  socket.on('connect', () => {
    console.log('Socket connesso:', socket.id);
    socket.emit('join_room', `autista_${userId}`);
  });
  socket.on('pending_update', (c) => console.log('Nuovo pending:', c));
  setTimeout(() => socket.disconnect(), 30000);
}

// Esecuzione
(async () => {
  const userId = await login();
  if (!userId) return;

  await testVeicoli(userId);
  const pending = await testPending(userId);

  if (pending && pending.length > 0) await testAccettaCorsa(pending[0].id);

  await testCorseGiornata(userId);
  testSocket(userId);
})();
