import fetch from 'node-fetch';

const BASE_URL = 'http://localhost:3001';

async function login(email, password) {
  const res = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
    credentials: 'include',
  });

  const cookies = res.headers.get('set-cookie'); // per cookie di sessione
  const data = await res.json();
  if (!res.ok) throw new Error(`Login fallito: ${JSON.stringify(data)}`);
  return cookies;
}

async function createPaymentIntent(cookies) {
  const slots = [
    {
      veicolo_id: 1,
      start_datetime: new Date().toISOString(),
      durata_minuti: 30,
      posti_richiesti: 2,
      origine: { lat: 45.4642, lon: 9.1900 }, // Milano centro
      destinazione: { lat: 45.4700, lon: 9.2050 }, // Milano zona est
    },
  ];

  const res = await fetch(`${BASE_URL}/booking/payment-intent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookies, // Passa il cookie di login
    },
    body: JSON.stringify({
      type: 'prenota',
      prezzo: 15.5,
      slots,
    }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(`Errore PaymentIntent: ${JSON.stringify(data)}`);
  return data;
}

(async () => {
  try {
    console.log('🚀 Login test utente...');
    const cookies = await login('mario.rossi@example.com', 'PasswordCliente123'); // <--- usa utente esistente

    console.log('📤 Creazione PaymentIntent...');
    const paymentData = await createPaymentIntent(cookies);

    console.log('✅ PaymentIntent creato:');
    console.log(JSON.stringify(paymentData, null, 2));
  } catch (err) {
    console.error(err);
  }
})();
