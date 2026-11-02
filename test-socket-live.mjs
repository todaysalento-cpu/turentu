
import { io } from 'socket.io-client';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const rl = readline.createInterface({ input: stdin, output: stdout });

const email = await rl.question('Email account di prova: ');
const password = await rl.question('Password account di prova: ');
rl.close();

try {
  const response = await fetch('https://turentu.onrender.com/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });

  if (!response.ok) {
    console.log('LOGIN_ERRORE HTTP', response.status);
    process.exit(1);
  }

  const { token } = await response.json();

  if (!token) throw new Error('TOKEN_ASSENTE');

  const socket = io('https://turentu.onrender.com', {
    transports: ['websocket'],
    auth: { token },
    reconnection: false,
    timeout: 10000
  });

  socket.on('connect', () => {
    console.log('SOCKET_IO_OK');
    socket.disconnect();
    process.exit(0);
  });

  socket.on('connect_error', (error) => {
    console.log('SOCKET_IO_ERRORE:', error.message);
    process.exit(1);
  });

  setTimeout(() => {
    console.log('SOCKET_IO_TIMEOUT');
    socket.disconnect();
    process.exit(1);
  }, 15000);

} catch (error) {
  console.log('TEST_ERRORE:', error.message);
  process.exit(1);
}
