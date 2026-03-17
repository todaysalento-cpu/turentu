// test_api_endpoints.js
import fetch from 'node-fetch';

const BASE_URL = 'http://localhost:3002/api'; // cambia con https://turentu.vercel.app/api in produzione
const TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6MSwicm9sZSI6ImF1dGlzdGEiLCJlbWFpbCI6Im1hcmlvQGVzZW1waW8uY29tIiwibm9tZSI6Ik1hcmlvIFJvc3NpIiwiaWF0IjoxNzczNjgxMTg2LCJleHAiOjE3NzQyODU5ODZ9.BRbge7K9Oi3qnFIfNJaNE6sctrUdzfnQdd-mr5T-dMY'; // opzionale, se serve auth

// Lista endpoint da testare
const endpoints = [
  { method: 'GET', path: '/ping' },
  { method: 'GET', path: '/auth' },
  { method: 'POST', path: '/auth/login', body: { email: 'test@test.com', password: '123456' } },
  { method: 'GET', path: '/notifications' },
  { method: 'GET', path: '/booking' },
  { method: 'GET', path: '/booking/cliente/1' },
  { method: 'GET', path: '/disponibilita' },
  { method: 'GET', path: '/veicolo' },
  { method: 'GET', path: '/corse' },
  { method: 'GET', path: '/pending' },
  { method: 'GET', path: '/tariffe' },
  { method: 'POST', path: '/distanza', body: { origine: 'Roma', destinazione: 'Milano' } },
  { method: 'GET', path: '/admin' },
  { method: 'GET', path: '/chat' },
];

(async () => {
  for (const ep of endpoints) {
    try {
      const options = {
        method: ep.method,
        headers: {
          'Content-Type': 'application/json',
          ...(TOKEN ? { 'Authorization': `Bearer ${TOKEN}` } : {}),
        },
        ...(ep.body ? { body: JSON.stringify(ep.body) } : {}),
      };

      console.log(`\n⚡ Invio richiesta ${ep.method} a ${BASE_URL}${ep.path}...`);

      const res = await fetch(BASE_URL + ep.path, options);
      const data = await res.text(); // prima testo, così eviti crash su body vuoti
      console.log(`✅ Status: ${res.status}`);
      try {
        console.log('Body:', JSON.parse(data));
      } catch {
        console.log('Body (raw):', data);
      }
    } catch (err) {
      console.error('❌ Errore fetch:', err.message);
    }
  }
})();