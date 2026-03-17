import fetchCookie from 'fetch-cookie';
import { CookieJar } from 'tough-cookie';
import { io } from 'socket.io-client';

const BASE_URL = 'http://localhost:3001';
const AUTISTA_ID = 2; // cambia se necessario

// Cookie jar per mantenere la sessione
const jar = new CookieJar();
const fetchAuth = fetchCookie(global.fetch, jar);

// ---------------- LOGIN ----------------
async function loginCliente() {
  console.log('\n--- LOGIN CLIENTE ---');

  const res = await fetchAuth(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'mario@example.com',   // ⚠️ usa un cliente reale
      password: 'PasswordCliente123'
    })
  });

  if (!res.ok) {
    console.error('Login fallito:', await res.text());
    process.exit(1);
  }

  const user = await res.json();
  console.log('Login riuscito:', user.nome);
  return user;
}

// ---------------- CREA PENDING ----------------
async function creaPending() {
  console.log('\n--- CREA PENDING ---');

  const body = {
    type: 'prenota',
    prezzo: 20.0,
    slots: [
      {
        veicolo_id: 2, // ⚠️ deve esistere
        start_datetime: new Date().toISOString(),
        durata: { minutes: 30 },
        posti_richiesti: 1,
        origine: { lat: 45.4642, lon: 9.19 },
        destinazione: { lat: 45.4700, lon: 9.20 },
        localitaOrigine: "Milano Centrale",
        localitaDestinazione: "Stazione Garibaldi"
      }
    ]
  };

  const res = await fetchAuth(`${BASE_URL}/booking/payment-intent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    console.error('Errore crea pending:', await res.text());
    process.exit(1);
  }

  const data = await res.json();
  console.log('Pending creato, ID:', data.pending[0].id);
  return data.pending[0];
}

// ---------------- SOCKET AUTISTA ----------------
function socketAutista(pending) {
  console.log('\n--- SOCKET AUTISTA ---');

  const socket = io(BASE_URL, { withCredentials: true });

  socket.on('connect', () => {
    console.log('Socket connesso autista:', socket.id);

    // entra nella stanza dell'autista
    socket.emit('join_autista', AUTISTA_ID);

    setTimeout(() => {
      console.log('Invio evento test pending_update...');
      socket.emit('pending_update', pending);
    }, 1000);
  });

  socket.on('pending_update', (data) => {
    console.log('Ricevuto pending_update:', data.id);
  });

  socket.on('connect_error', (err) => {
    console.error('Errore socket:', err.message);
  });
}

// ---------------- ACCETTA PENDING ----------------
async function accettaPending(pendingId) {
  console.log('\n--- ACCETTA PENDING ---');

  const res = await fetchAuth(`${BASE_URL}/pending/${pendingId}/accetta`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ allSlots: false }),
  });

  const text = await res.text();
  if (!res.ok) {
    console.error('Risposta backend:', text);
    throw new Error('Errore accettazione pending');
  }

  const data = JSON.parse(text);
  console.log('Pending accettato:', data.pendings[0].stato);
  return data;
}

// ---------------- AVVIO TEST ----------------
(async () => {
  try {
    const user = await loginCliente();
    const pending = await creaPending();
    socketAutista(pending);

    // aspetta un paio di secondi prima di accettare per dare tempo allo socket
    setTimeout(async () => {
      try {
        const result = await accettaPending(pending.id);
        console.log('✅ Test completato con successo');
        console.log('Pendings finali:', result.pendings);
      } catch (err) {
        console.error('❌ Test fallito:', err);
      }
    }, 2000);

  } catch (err) {
    console.error('Errore generale test:', err);
  }
})();
