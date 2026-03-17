import fetch from 'node-fetch';

async function login() {
  const res = await fetch('http://localhost:3001/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'test@example.com',
      password: 'PasswordCliente123'
    }),
  });

  const cookies = res.headers.get('set-cookie'); // qui prendi il cookie
  console.log('Cookie ricevuto:', cookies);

  const data = await res.json();
  console.log('Risposta login:', data);

  return cookies; // puoi usarlo nei test
}

login();
