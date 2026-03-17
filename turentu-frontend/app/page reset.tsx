'use client';

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { motion } from 'framer-motion';
import io, { Socket } from 'socket.io-client';

// Import dinamico della mappa per evitare crash SSR
const Map = dynamic(() => import('../components/Map'), { ssr: false });

// Socket.io (porta backend 3001)
let socket: Socket;

export default function Page() {
  const [connected, setConnected] = useState(false);
  const [messages, setMessages] = useState<string[]>([]);
  const [input, setInput] = useState('');

  useEffect(() => {
    socket = io('http://localhost:3001');

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));

    socket.on('reply', (msg: string) => {
      setMessages((prev) => [...prev, msg]);
    });

    return () => socket.disconnect();
  }, []);

  const sendMessage = () => {
    if (!input.trim()) return;
    socket.emit('message', input);
    setMessages((prev) => [...prev, `Client: ${input}`]);
    setInput('');
  };

  return (
    <div className="min-h-screen bg-gray-100 p-4 flex flex-col gap-4">
      <motion.h1
        className="text-2xl font-bold"
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
      >
        TURENTU Dashboard
      </motion.h1>

      <div className="p-4 bg-white rounded shadow flex flex-col gap-2">
        <p>Status Socket.io: {connected ? '🟢 Connesso' : '🔴 Disconnesso'}</p>

        <div className="flex gap-2">
          <input
            className="border p-2 flex-1 rounded"
            type="text"
            placeholder="Scrivi un messaggio..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && sendMessage()}
          />
          <button
            className="bg-blue-500 text-white px-4 py-2 rounded hover:bg-blue-600"
            onClick={sendMessage}
          >
            Invia
          </button>
        </div>

        <div className="max-h-40 overflow-y-auto border-t mt-2 pt-2">
          {messages.map((m, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              className="text-sm"
            >
              {m}
            </motion.div>
          ))}
        </div>
      </div>

      <div className="flex-1">
        <Map />
      </div>
    </div>
  );
}
