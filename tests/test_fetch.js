import fetchCookie from 'fetch-cookie';
import { CookieJar } from 'tough-cookie';

const jar = new CookieJar();
const fetchAuth = fetchCookie(global.fetch, jar);

// LOGIN
await fetchAuth('http://localhost:3001/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'mario@example.com', password: 'PasswordCliente123' })
});

// FETCH dopo login
const res = await fetchAuth('http://localhost:3001/pending/autista/2');
const data = await res.json();
console.log(data);
