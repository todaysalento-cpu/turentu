'use client';

import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useSocket } from '../context/SocketProvider';
import { Message } from '../types'; // tipo aggiornato con sender_name e role

interface ChatCorsaProps {
  corsaId: number;
  userRole: 'Cliente' | 'Autista';
  userId: number;
}

export default function ChatCorsa({ corsaId, userRole, userId }: ChatCorsaProps) {
  const { socket } = useSocket();
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const shouldScrollRef = useRef(true);

  // ================= SOCKET =================
  useEffect(() => {
    if (!socket || !corsaId) return;

    // join room + fetch iniziale
    const joinRoom = () => {
      socket.emit('join_corsa_chat', corsaId);
      socket.emit('get_chat_messages', corsaId);
    };

    if (!socket.connected) socket.once('connect', joinRoom);
    else joinRoom();

    // Listener messaggi nuovi
    const handleNewMessage = (msg: Message) => {
      if (msg.corsa_id === corsaId) setMessages(prev => [...prev, msg]);
    };

    // Listener messaggi iniziali dal server
    const handleInitMessages = (msgs: Message[]) => setMessages(msgs);

    socket.on('new_message', handleNewMessage);
    socket.on(`init_chat_${corsaId}`, handleInitMessages);

    return () => {
      // pulizia completa
      socket.emit('leave_corsa_chat', corsaId);
      socket.off('new_message', handleNewMessage);
      socket.off(`init_chat_${corsaId}`, handleInitMessages);
      socket.off('connect', joinRoom);
    };
  }, [socket, corsaId]);

  // ================= SCROLL =================
  const scrollToBottom = useCallback((smooth = true) => {
    messagesEndRef.current?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto' });
  }, []);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    shouldScrollRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
  };

  useEffect(() => {
    if (shouldScrollRef.current) scrollToBottom();
  }, [messages, scrollToBottom]);

  // ================= SEND MESSAGE =================
  const sendMessage = useCallback(() => {
    if (!text.trim() || !socket) return;

    const tempMsg: Message = {
      id: `temp-${Date.now()}`,
      corsa_id: corsaId,
      sender_id: userId,
      sender_name: userRole,
      role: userRole,
      text: text.trim(),
      timestamp: new Date().toISOString(),
      read: true,
    };

    // mostra temporaneamente
    setMessages(prev => [...prev, tempMsg]);
    setText('');

    if (!socket.connected) return;

    // invio al server
    socket.emit('send_message', { corsa_id: corsaId, text: tempMsg.text }, (serverMsg: Message) => {
      // sostituisci temporaneo con confermato dal server
      setMessages(prev =>
        prev.map(m => (m.id === tempMsg.id ? serverMsg : m))
      );
    });
  }, [text, socket, corsaId, userRole, userId]);

  return (
    <div className="flex flex-col h-full rounded-xl shadow-md border border-gray-200 bg-white overflow-hidden">
      {/* MESSAGES */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-4 py-3 space-y-2 bg-gray-50"
      >
        {messages.length === 0 && <p className="text-gray-400 text-center mt-4">Nessun messaggio</p>}

        {messages.map(msg => {
          const mine = msg.sender_id === userId;
          const isTemp = typeof msg.id === 'string' && msg.id.startsWith('temp-');

          return (
            <div
              key={msg.id}
              className={`flex flex-col max-w-[75%] px-4 py-2 rounded-2xl break-words text-sm ${
                mine
                  ? 'bg-blue-500 text-white self-end rounded-br-none'
                  : 'bg-gray-200 text-gray-900 self-start rounded-bl-none'
              } ${isTemp ? 'opacity-70 italic' : ''}`}
            >
              <div className="mb-1 font-semibold text-xs opacity-70">
                {msg.sender_name} ({msg.role})
              </div>
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
          disabled={!text.trim()}
          className="bg-blue-500 text-white px-4 py-2 rounded-full hover:bg-blue-600 transition-colors text-sm font-semibold disabled:opacity-50"
        >
          Invia
        </button>
      </div>
    </div>
  );
}