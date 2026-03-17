// tests/test_payment_complete_capture.js
import 'dotenv/config';           // carica .env
import fetch from 'node-fetch';
import Stripe from 'stripe';

const BASE_URL = 'http://localhost:3001';
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
if (!STRIPE_SECRET_KEY) throw new Error('⚠️ STRIPE_SECRET_KEY non trovata');

const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2022-11-15' });

const email = 'test@example.com';
const password = 'PasswordCliente123';

async function runFullTest() {
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

    // ---------------- AUTH/ME ----------------
    const meRes = await fetch(`${BASE_URL}/auth/me`, {
      method: 'GET',
      headers: { 'Cookie': tokenCookie },
    });

    const meData = await meRes.json();
    if (!meRes.ok) {
      console.error('❌ /auth/me fallito:', meData);
      return;
    }
    console.log('✅ /auth/me:', meData);

    // ---------------- PAYMENT INTENT ----------------
    const body = {
      type: 'prenota',
      prezzo: 10.5,
      pendingId: '1234',
      corsaId: '5678',
    };

    const paymentRes = await fetch(`${BASE_URL}/booking/payment-intent`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Cookie': tokenCookie 
      },
      body: JSON.stringify(body)
    });

    const paymentData = await paymentRes.json();
    if (!paymentRes.ok) {
      console.error('❌ PaymentIntent fallito:', paymentData);
      return;
    }

    console.log('✅ PaymentIntent creato:', paymentData);

    // ---------------- CONFIRM PAYMENT ----------------
    const paymentIntentId = paymentData.clientSecret.split('_secret')[0];

    const confirmed = await stripe.paymentIntents.confirm(paymentIntentId, {
      payment_method: 'pm_card_visa', // carta test Stripe
    });
    console.log('✅ PaymentIntent confermato:', {
      id: confirmed.id,
      status: confirmed.status,
      amount: confirmed.amount / 100 + '€',
    });

    // ---------------- CAPTURE PAYMENT ----------------
    if (confirmed.status === 'requires_capture') {
      const captured = await stripe.paymentIntents.capture(confirmed.id);
      console.log('✅ PaymentIntent catturato:', {
        id: captured.id,
        status: captured.status,
        amount: captured.amount / 100 + '€',
      });
    }

  } catch (err) {
    console.error('❌ Errore test completo:', err);
  }
}

runFullTest();
