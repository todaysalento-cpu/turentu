import fetchCookie from 'fetch-cookie';
import { CookieJar } from 'tough-cookie';
import { io } from 'socket.io-client';

const BASE_URL = 'http://localhost:3001';
const AUTISTA_ID = 2; // cambia se necessario

// ---------------- COOKIE JAR ----------------
const jar = new CookieJar();
const fetchAuth = fetchCookie(global.fetch, jar);

// ---------------- LOGIN ----------------
async function login() {
  console.log('\n--- LOGIN ---');

  const res = await fetchAuth(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'mario@example.com', // utente cliente esistente
      password: 'PasswordCliente123'
    })
  });

  if (!res.ok) {
    console.error('Login fallito:', await res.text());
    process.exit(1);
  }

  const user = await res.json();
  console.log('Login riuscito:', user);
}

// ---------------- CREA PAYMENT INTENT + PENDING ----------------
async function creaPending() {
  console.log('\n--- CREA PENDING ---');

  const body = {
    type: 'prenota',
    prezzo: 20.0,
    slots: [
      {
        veicolo_id: 2, // deve esistere
        start_datetime: new Date().toISOString(),
        durata_minuti: 30,
        posti_richiesti: 1,
        origine: { lat: 45.4642, lon: 9.19 },
        destinazione: { lat: 45.4700, lon: 9.20 },
        localitaOrigine: "Piazza Duomo, Milano",
        localitaDestinazione: "Corso Vittorio Emanuele II, Milano"
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
  console.log('PaymentIntent creato');
  console.log('Pending DB:', data.pending);

  return data.pending[0]; // ritorna il primo slot
}

// ---------------- SOCKET ----------------
function inviaSocket(pending) {
  console.log('\n--- SOCKET ---');

  const socket = io(BASE_URL, { withCredentials: true });

  socket.on('connect', () => {
    console.log('Socket connesso:', socket.id);

    // entra nella stanza dell’autista
    socket.emit('join_autista', AUTISTA_ID);

    // invia evento dopo 1s per dare tempo al backend di salvare pending_id
    setTimeout(() => {
      console.log('Invio evento pending_update...');
      socket.emit('pending_update', { id: pending.id, status: 'accettata' });
    }, 1000);
  });

  socket.on('pending_update', (data) => {
    console.log('Ricevuto pending_update:', data);
  });

  socket.on('connect_error', (err) => {
    console.error('Errore socket:', err.message);
  });
}

// ---------------- AVVIO ----------------
(async () => {
  try {
    await login();
    const pending = await creaPending();
    inviaSocket(pending);
  } catch (err) {
    console.error('Errore generale:', err);
  }
})();
