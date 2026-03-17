import fetch from 'node-fetch';
import fetchCookie from 'fetch-cookie';
import { CookieJar } from 'tough-cookie';
import { pool } from '../db/db.js'; // Assicurati di avere l'export di pool

const jar = new CookieJar();
const fetchWithCookies = fetchCookie(fetch, jar);

const AUTISTA_ID = 5;

async function run() {
  try {
    // -------------------- Pulisci tabella pending --------------------
    await pool.query('DELETE FROM pending');
    console.log('🧹 Tabella pending svuotata');

    // -------------------- LOGIN AUTISTA --------------------
    const loginRes = await fetchWithCookies(
      'http://localhost:3001/auth/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'nuovo.autista@example.com',
          password: 'prova1234'
        })
      }
    );

    if (!loginRes.ok) {
      const err = await loginRes.text();
      console.error('❌ Login fallito:', err);
      return;
    }

    console.log('✅ Login autista OK');

    // -------------------- FETCH PENDING --------------------
    const res = await fetchWithCookies(
      `http://localhost:3001/pending/autista/${AUTISTA_ID}`
    );

    const data = await res.json();
    console.log(`📥 Pending per autista ${AUTISTA_ID}:`, data);

  } catch (err) {
    console.error('❌ Errore test pending:', err);
  } finally {
    // chiudi la connessione al DB
    await pool.end();
  }
}

run();
