import fetch from 'node-fetch';

async function accettaPending(token, pendingId) {
  const res = await fetch(`http://localhost:3001/pending/${pendingId}/accetta`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `token=${token}` // solo token=value
    }
  });

  const data = await res.json();
  console.log('Risposta accetta pending:', data);
}

// LOGIN e uso token
(async () => {
  const loginRes = await fetch('http://localhost:3001/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'test@example.com', password: 'PasswordCliente123' })
  });

  const loginData = await loginRes.json();
  const rawCookie = loginRes.headers.get('set-cookie'); 
  const token = rawCookie?.match(/token=([^;]+)/)?.[1]; 

  console.log('Token:', token);

  if (!token) return console.error('Nessun token ricevuto dal login');

  await accettaPending(token, 63);
})();
