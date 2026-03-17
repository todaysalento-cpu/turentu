import fetch from 'node-fetch';
import crypto from 'crypto';

// 🔹 URL corretto del webhook
const WEBHOOK_URL = 'http://localhost:3001/webhook-stripe';

// 🔹 Deve combaciare con .env
const STRIPE_WEBHOOK_SECRET =
  process.env.STRIPE_WEBHOOK_SECRET ||
  'whsec_0f0d641a20a3c948f120eeb23b300dad9b00847a3c719a2dff3bc2d2c703e0e9';

// ----------------------------------------------------
// Genera Stripe-Signature (v1) fake
// ----------------------------------------------------
function generateStripeSignature(payload) {
  const timestamp = Math.floor(Date.now() / 1000);
  const signedPayload = `${timestamp}.${payload}`;

  const signature = crypto
    .createHmac('sha256', STRIPE_WEBHOOK_SECRET)
    .update(signedPayload)
    .digest('hex');

  return `t=${timestamp},v1=${signature}`;
}

// ----------------------------------------------------
// Invia evento al webhook
// ----------------------------------------------------
async function sendEvent(type, metadata = {}) {
  const payload = JSON.stringify({
    id: `evt_${Math.random().toString(36).slice(2)}`,
    type,
    data: {
      object: {
        id: `pi_${Math.random().toString(36).slice(2)}`,
        metadata
      }
    }
  });

  const signature = generateStripeSignature(payload);

  const res = await fetch(WEBHOOK_URL, {
    method: 'POST',
    body: payload, // ⚡ RAW body
    headers: {
      'Content-Type': 'application/json',
      'Stripe-Signature': signature
    }
  });

  const text = await res.text();
  console.log(`✅ Evento ${type} → risposta:`, text);
}

// ----------------------------------------------------
// TEST END-TO-END
// ----------------------------------------------------
(async () => {
  try {
    console.log('--- TEST STRIPE WEBHOOK START ---');

    // 1️⃣ succeeded → richiedi
    await sendEvent('payment_intent.succeeded', {
      tipo: 'richiedi',
      pendingId: '1',   // ⚠️ assicurati esista nel DB
      clienteId: '10'
    });

    // 2️⃣ payment_failed → prenota
    await sendEvent('payment_intent.payment_failed', {
      tipo: 'prenota',
      corsaId: '5',
      clienteId: '20'
    });

    // 3️⃣ amount_capturable_updated → prenota
    await sendEvent('payment_intent.amount_capturable_updated', {
      tipo: 'prenota',
      corsaId: '7',
      clienteId: '30'
    });

    console.log('--- TEST STRIPE WEBHOOK END ---');
  } catch (err) {
    console.error('❌ Test webhook error:', err);
  }
})();
