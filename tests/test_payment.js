// tests/test_payment_intent.js
import fetch from 'node-fetch';

const BASE_URL = 'http://localhost:3001';
const email = 'test@example.com';
const password = 'PasswordCliente123';

async function testPaymentIntent() {
  try {
    // ---------------- LOGIN ----------------
    const loginRes = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    if (!loginRes.ok) {
      console.error('❌ Login fallito:', await loginRes.text());
      return;
    }

    const setCookie = loginRes.headers.get('set-cookie');
    if (!setCookie) {
      console.error('❌ Cookie non trovato');
      return;
    }

    const tokenCookie = setCookie.split(';')[0];
    console.log('✅ Login riuscito, cookie ricevuto:', tokenCookie);

    // ---------------- PAYMENT INTENT ----------------
    const body = {
      type: 'prenota',    // o 'richiedi'
      prezzo: 10.5,       // prezzo in euro
      pendingId: '1234',
      corsaId: '5678'
    };

    const paymentRes = await fetch(`${BASE_URL}/booking/payment-intent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': tokenCookie
      },
      body: JSON.stringify(body)
    });

    const data = await paymentRes.json();

    if (!paymentRes.ok) {
      console.error('❌ PaymentIntent fallito:', data);
      return;
    }

    console.log('✅ PaymentIntent creato:', data);

  } catch (err) {
    console.error('❌ Errore test payment:', err);
  }
}

testPaymentIntent();
