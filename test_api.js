import fetch from 'node-fetch';

const url = 'http://localhost:3002/api/ping'; // 🔹 endpoint di test aperto
const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6MSwicm9sZSI6ImF1dGlzdGEiLCJlbWFpbCI6Im1hcmlvQGVzZW1waW8uY29tIiwibm9tZSI6Ik1hcmlvIFJvc3NpIiwiaWF0IjoxNzczNjgxMTg2LCJleHAiOjE3NzQyODU5ODZ9.BRbge7K9Oi3qnFIfNJaNE6sctrUdzfnQdd-mr5T-dMY';

(async () => {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000); // timeout 5s

    console.log(`⚡ Invio richiesta GET a ${url}...`);

    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` }, // puoi rimuovere il token se l'endpoint è aperto
      signal: controller.signal
    });

    clearTimeout(timeout);

    console.log('✅ Status:', res.status);

    if (!res.ok) {
      console.error('❌ Risposta non OK:', res.statusText);
      const text = await res.text();
      console.log('Body:', text);
      return;
    }

    const data = await res.json();
    console.log('📦 Data ricevuti:', data);

  } catch (err) {
    if (err.name === 'AbortError') {
      console.error('⏱️ Errore: richiesta scaduta (timeout)');
    } else {
      console.error('❌ Errore fetch:', err.message);
    }
  }
})();