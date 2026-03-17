import fetch from 'node-fetch';
import { parse } from 'cookie';

const BASE_URL = 'http://localhost:3001'; // backend su porta 3001

async function main() {
  try {
    // -------------------- LOGIN --------------------
    console.log('📌 Login test user...');
    const loginRes = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'test@example.com', password: 'PasswordCliente123' }),
    });

    console.log('Login status:', loginRes.status);
    const loginRaw = await loginRes.text();
    console.log('Login raw response:', loginRaw);

    // estrai cookie
    const cookies = loginRes.headers.get('set-cookie') || '';
    const parsedCookies = parse(cookies);
    const token = parsedCookies.token;

    if (!token) throw new Error('Token non ricevuto dal login');
    console.log('✅ Cookie token:', `token=${token}`);

    // -------------------- CREAZIONE CORSA DI TEST --------------------
    console.log('📌 Creazione corsa di test...');
    const durataMinutes = 15;

    const corsaRes = await fetch(`${BASE_URL}/corse/crea-test`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `token=${token}`,
      },
      body: JSON.stringify({
        veicolo_id: 1,
        start_datetime: new Date().toISOString(),
        tipo_corsa: 'condivisa',
        origine: '0101000020E6100000E17A14AE47612240CF66D5E76ABB4640',
        destinazione: '0101000020E6100000295C8FC2F56822405C8FC2F528BC4640',
        durata: `${durataMinutes} minutes`, // ✅ formato PostgreSQL interval
        prezzo: 10,
      }),
    });

    const corsa = await corsaRes.json();
    console.log('✅ Corsa di test creata:', corsa);

    // -------------------- CREAZIONE PAYMENTINTENT --------------------
    console.log('📌 Creazione PaymentIntent...');
    const paymentRes = await fetch(`${BASE_URL}/payments/create-intent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `token=${token}`,
      },
      body: JSON.stringify({ corsa_id: corsa.id }),
    });

    const payment = await paymentRes.json();

    if (!payment || !payment.pending || payment.pending.length === 0) {
      throw new Error('Nessuna corsa pendente trovata dopo PaymentIntent');
    }

    console.log('✅ PaymentIntent confermato:', payment);

    // -------------------- SIMULAZIONE CAPTURE --------------------
    console.log('📌 Simulazione capture...');
    const captureRes = await fetch(`${BASE_URL}/payments/capture`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `token=${token}`,
      },
      body: JSON.stringify({ payment_intent_id: payment.pending[0].payment_intent_id }),
    });

    const capture = await captureRes.json();
    console.log('✅ Payment captured:', capture);

  } catch (err) {
    console.error('❌ Errore flusso completo:', err);
  }
}

main();
