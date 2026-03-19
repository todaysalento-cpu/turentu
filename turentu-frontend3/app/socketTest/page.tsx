'use client';

import { useEffect, useState } from 'react';
import { io, Socket } from 'socket.io-client';

export default function SocketTest() {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [messages, setMessages] = useState<any[]>([]);
  const [input, setInput] = useState('');

  useEffect(() => {
    const s = io('http://localhost:3002'); // porta del test server
    setSocket(s);

    s.on('connect', () => {
      console.log('Connesso al test server con id:', s.id);
      setMessages(prev => [...prev, `Connesso con id: ${s.id}`]);
    });

    s.on('test', (data) => {
      console.log('Risposta dal server:', data);
      setMessages(prev => [...prev, `Server: ${JSON.stringify(data)}`]);
    });

    return () => {
      s.disconnect();
    };
  }, []);

  const sendMessage = () => {
    if (!socket || !input) return;
    socket.emit('test', { msg: input });
    setMessages(prev => [...prev, `Tu: ${input}`]);
    setInput('');
  };

  return (
    <div className="p-6 space-y-4">
      <h1 className="text-xl font-bold">Socket Test</h1>

      <div className="border p-3 h-64 overflow-y-auto bg-gray-50">
        {messages.map((m, i) => (
          <div key={i} className="text-sm">{m}</div>
        ))}
      </div>

      <div className="flex gap-2">
        <input
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          className="border p-2 flex-1 rounded"
          placeholder="Scrivi un messaggio..."
        />
        <button
          onClick={sendMessage}
          className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
        >
          Invia
        </button>
      </div>
    </div>
  );
}