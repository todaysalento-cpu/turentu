'use client';

import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useSocket } from './../context/SocketProvider';

interface ChatCorsaProps {
  corsaId: number;
  userRole: 'Cliente' | 'Autista';
  messages: Message[];
  onReadMessages?: () => void;
}

interface Message {
  id: number;
  corsa_id: number;
  sender_id: number;
  user: 'Cliente' | 'Autista';
  text: string;
  timestamp: string;
  read?: boolean;
}

export default function ChatCorsa({
  corsaId,
  userRole,
  messages,
  onReadMessages
}: ChatCorsaProps) {
  const { socket } = useSocket();
  const [text, setText] = useState('');
  const containerRef = useRef<HTMLDivElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const shouldScrollRef = useRef(true);

  // ================= SCROLL =================
  const scrollToBottom = useCallback((smooth = true) => {
    messagesEndRef.current?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto' });
  }, []);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
    shouldScrollRef.current = atBottom;
  };

  // ================= AUTO SCROLL =================
  useEffect(() => {
    if (shouldScrollRef.current) scrollToBottom();
  }, [messages, scrollToBottom]);

  // ================= READ MESSAGES =================
  useEffect(() => {
    onReadMessages?.();
  }, []); // solo al montaggio

  // ================= INVIO MESSAGGIO =================
  const sendMessage = useCallback(() => {
    if (!text.trim() || !socket) return;
    const msg = { corsa_id: corsaId, text: text.trim() };
    socket.emit('send_message', msg);
    setText('');
  }, [text, socket, corsaId]);

  return (
    <div className="flex flex-col h-full rounded-xl shadow-md border border-gray-200 bg-white overflow-hidden">
      {/* CHAT MESSAGES */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-4 py-3 space-y-2 bg-gray-50"
      >
        {messages.length === 0 && (
          <p className="text-gray-400 text-center mt-4">
            Nessun messaggio presente
          </p>
        )}

        {messages.map(msg => {
          const mine = msg.user === userRole;
          return (
            <div
              key={msg.id}
              className={`flex flex-col max-w-[75%] px-4 py-2 rounded-2xl break-words text-sm ${
                mine
                  ? 'bg-blue-500 text-white self-end rounded-br-none'
                  : 'bg-gray-200 text-gray-900 self-start rounded-bl-none'
              }`}
            >
              <div className="mb-1 font-semibold text-xs opacity-70">{msg.user}</div>
              <div>{msg.text}</div>
              <div className="text-[10px] mt-1 text-right opacity-50">
                {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </div>
            </div>
          );
        })}

        <div ref={messagesEndRef} />
      </div>

      {/* INPUT */}
      <div className="flex items-center gap-2 px-3 py-2 border-t border-gray-200 bg-white">
        <input
          type="text"
          value={text}
          placeholder="Scrivi un messaggio..."
          onChange={e => setText(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && sendMessage()}
          className="flex-1 border rounded-full px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
        />
        <button
          onClick={sendMessage}
          className="bg-blue-500 text-white px-4 py-2 rounded-full hover:bg-blue-600 transition-colors text-sm font-semibold"
        >
          Invia
        </button>
      </div>
    </div>
  );
}