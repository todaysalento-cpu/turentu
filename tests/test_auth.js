// tests/test_auth.js
import fetch from 'node-fetch';

const BASE_URL = 'http://localhost:3001';

// Credenziali dell'utente di test
const email = 'test@example.com';
const password = 'PasswordCliente123';

async function testAuth() {
  try {
    // ---------------- LOGIN ----------------
    const loginRes = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    if (!loginRes.ok) {
      const errText = await loginRes.text();
      console.error('❌ Login fallito:', errText);
      return;
    }

    // Prendere il cookie JWT dall'header Set-Cookie
    const setCookie = loginRes.headers.get('set-cookie');
    if (!setCookie) {
      console.error('❌ Cookie non trovato nell’header di login');
      return;
    }

    // Estrarre solo il token
    const tokenCookie = setCookie.split(';')[0]; // "token=xxx"
    console.log('✅ Login riuscito, cookie ricevuto:', tokenCookie);

    // ---------------- ME ----------------
    const meRes = await fetch(`${BASE_URL}/auth/me`, {
      method: 'GET',
      headers: {
        'Cookie': tokenCookie,
      },
    });

    const meData = await meRes.json();

    if (!meRes.ok) {
      console.error('❌ /auth/me fallito:', meData);
      return;
    }

    console.log('✅ /auth/me:', meData);

    // ---------------- TEST PAYMENT-INTENT (opzionale) ----------------
    // Se vuoi testare anche il pagamento, aggiungi qui la chiamata
    // usando lo stesso tokenCookie nei fetch con `credentials: "include"`

  } catch (err) {
    console.error('❌ Errore test auth:', err);
  }
}

testAuth();
