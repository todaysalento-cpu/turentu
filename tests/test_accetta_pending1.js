// tests/test_accetta_pending1.js
import fetch from 'node-fetch';              // fetch per chiamate HTTP
import { io as ioClient } from 'socket.io-client'; // socket.io client
import 'dotenv/config';

const BASE_URL = 'http://localhost:3001';
const EMAIL = 'mario.rossi@example.com';
const PASSWORD = 'PasswordCliente123';

// Qui metti l'ID reale del pending creato da test_pending3.js
const PENDING_ID_REAL = 114;

async function login() {
  const res = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    credentials: 'include',
  });

  if (!res.ok) throw new Error(`Login fallito: ${await res.text()}`);
  console.log('✅ Login riuscito');
  
  // Prende il cookie di sessione (opzionale, dipende dal backend)
  return res.headers.get('set-cookie') || '';
}

async function accettaPending(pendingId, cookie) {
  const res = await fetch(`${BASE_URL}/pending/${pendingId}/accetta`, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      Cookie: cookie
    },
  });

  const data = await res.json();
  if (res.ok) {
    console.log('✅ Pending accettato:', data);
  } else {
    console.error('❌ Errore accetta pending:', data);
  }
}

async function runTest() {
  try {
    console.log('🚀 Login test utente...');
    const cookie = await login();

    console.log('📡 Connetto socket.io...');
    const socket = ioClient(BASE_URL, { withCredentials: true });

    socket.on('connect', () => console.log('✅ Connesso al socket:', socket.id));
    socket.on('disconnect', () => console.log('🔴 Socket disconnesso'));
    socket.on('pending_update', (pending) => console.log('🔔 Pending aggiornato:', pending));

    // Accetta il pending corretto
    console.log(`🔑 Accetto pending ID: ${PENDING_ID_REAL}`);
    await accettaPending(PENDING_ID_REAL, cookie);

    // Mantieni socket aperto per ricevere eventuali eventi
    setTimeout(() => {
      console.log('🛑 Test terminato');
      socket.disconnect();
    }, 5000);

  } catch (err) {
    console.error('❌ Test fallito:', err);
  }
}

runTest();
