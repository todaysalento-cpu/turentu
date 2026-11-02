
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const file = path.resolve('tests/test-popbus-http-ar-e2e.cjs');
const backup = path.resolve('tests/test-popbus-http-ar-e2e.backup.cjs');

const original = fs.readFileSync(file, 'utf8');
const saved = fs.readFileSync(backup, 'utf8');

if (original !== saved) {
  throw new Error('STOP: il test è diverso dal backup');
}

let code = original;

function replaceOnce(before, after) {
  const first = code.indexOf(before);
  if (first < 0 || code.indexOf(before, first + 1) >= 0) {
    throw new Error('STOP: ancoraggio assente o ambiguo');
  }
  code = code.replace(before, after);
}

replaceOnce(
  ' let server;\n try {',
  ` let server;
 let io;
 let socketClient;
 const socketEvents = [];
 const socketMode = process.argv.includes('--socket');
 try {`
);

replaceOnce(
  "   const base='http://127.0.0.1:'+server.address().port;",
  `   const base='http://127.0.0.1:'+server.address().port;
   if (socketMode) {
     const { Server } = require('socket.io');
     const { io: connect } = require('socket.io-client');
     const socketModule = await import(pathToFileURL(resolve('socket.js')).href);

     io = new Server(server, {
       path: '/socket.io/',
       transports: ['websocket']
     });
     socketModule.setupSocket(io);

     socketClient = connect(base, {
       path: '/socket.io/',
       transports: ['websocket'],
       auth: {
         token: jwt.sign(
           { id: 2, role: 'autista' },
           process.env.JWT_SECRET,
           { expiresIn: '5m' }
         )
       },
       reconnection: false,
       timeout: 5000
     });

     await new Promise((resolve, reject) => {
       const timer = setTimeout(
         () => reject(new Error('Timeout connessione Socket.IO')),
         7000
       );
       socketClient.once('connect', () => {
         clearTimeout(timer);
         resolve();
       });
       socketClient.once('connect_error', error => {
         clearTimeout(timer);
         reject(error);
       });
     });

     socketClient.on('nuova_corsa_popbus', corsa => {
       socketEvents.push(corsa);
     });
     console.log('PASS: Socket.IO NCC 2 connesso');
   }`
);

replaceOnce(
  "   console.log('PASS: prima accettazione HTTP -> 202');",
  `   console.log('PASS: prima accettazione HTTP -> 202');
   if (socketMode) {
     await new Promise(resolve => setTimeout(resolve, 250));
     assert.equal(socketEvents.length, 0,
       'Notifica anticipata prima della finalizzazione A/R');
     console.log('PASS: nessuna notifica dopo la prima accettazione');
   }`
);

replaceOnce(
  "   console.log('PASS: seconda accettazione HTTP -> 200 con 2 corse');",
  `   console.log('PASS: seconda accettazione HTTP -> 200 con 2 corse');
   if (socketMode) {
     const deadline = Date.now() + 5000;
     while (socketEvents.length < 2 && Date.now() < deadline) {
       await new Promise(resolve => setTimeout(resolve, 50));
     }
     assert.equal(socketEvents.length, 2,
       'Attese esattamente due notifiche Socket.IO');

     const expectedIds = r.body.corse.map(x => Number(x.id)).sort((a,b)=>a-b);
     const receivedIds = socketEvents.map(x => Number(x.id)).sort((a,b)=>a-b);
     assert.deepEqual(receivedIds, expectedIds,
       'Gli ID notificati non coincidono con le corse confermate');

     console.log('PASS: due notifiche Socket.IO corrispondenti alle corse A/R');
   }`
);

replaceOnce(
  "   console.log('PASS: retry HTTP idempotente');",
  `   console.log('PASS: retry HTTP idempotente');
   if (socketMode) {
     await new Promise(resolve => setTimeout(resolve, 300));
     assert.equal(socketEvents.length, 2,
       'Il retry ha generato notifiche duplicate');
     console.log('PASS: retry senza notifiche duplicate');
   }`
);

replaceOnce(
  "   if(server) await new Promise(resolve=>server.close(resolve));",
  `   if(socketClient) socketClient.disconnect();
   if(io) await new Promise(resolve=>io.close(resolve));
   else if(server) await new Promise(resolve=>server.close(resolve));`
);

fs.writeFileSync(file, code, 'utf8');
console.log('PASS: patch Socket.IO applicata');
