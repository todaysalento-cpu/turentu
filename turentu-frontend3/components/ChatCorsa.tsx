'use client';

import React, { useState, useEffect, useRef } from 'react';
import { Message } from '../context/ChatContext';
import { Socket } from 'socket.io-client';

interface ChatCorsaProps {
  corsaId: number;
  socket: Socket;
  messages: Message[];
  userRole?: 'Cliente' | 'Autista';
  onReadMessages?: () => void;
}

export default function ChatCorsa({
  corsaId,
  socket,
  messages,
  userRole = 'Cliente',
  onReadMessages
}: ChatCorsaProps) {
  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  // Scroll automatico in basso
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const formatTime = (timestamp: string | Date) => {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    return date.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  };

  const formatFullDate = (timestamp: string | Date) => {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    return date.toLocaleString('it-IT', { day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  const sendMessage = () => {
    if (!input.trim()) return;
    const tempId = 'temp-' + Date.now();

    // Messaggio temporaneo locale
    const newMsg: Message = {
      id: tempId,
      text: input,
      role: userRole.toLowerCase(),
      timestamp: new Date().toISOString(),
      read_status: { cliente: false, autista: false }
    };

    socket.emit('send_message', { corsa_id: corsaId, text: input });
    setInput('');
    // Possiamo aggiungere il messaggio temporaneo direttamente al parent o gestirlo localmente
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto p-2 space-y-2">
        {messages.map((msg, index) => {
          const role = msg.role?.toLowerCase() || 'cliente';
          const isAutista = role === 'autista';
          const isOwnMessage = role === userRole.toLowerCase();
          const isTemp = typeof msg.id === 'string' && msg.id.startsWith('temp-');

          const readByOther = isOwnMessage && (
            userRole.toLowerCase() === 'autista' ? msg.read_status.cliente : msg.read_status.autista
          );

          return (
            <div key={`${msg.id}-${index}`} className={`flex ${isAutista ? 'justify-start' : 'justify-end'}`}>
              <div
                className={`
                  max-w-[70%] px-3 py-2 rounded-xl text-sm
                  ${isAutista ? 'bg-gray-200 text-gray-900 rounded-tl-none' : 'bg-green-500 text-white rounded-tr-none'}
                  ${isTemp ? 'opacity-70 italic' : ''}
                  relative
                `}
                title={formatFullDate(msg.timestamp)}
              >
                <div>{msg.text || ''}</div>
                <div className="text-[9px] mt-1 flex items-center justify-end space-x-1">
                  <span className={isAutista ? 'text-gray-500' : 'text-gray-200'}>
                    {formatTime(msg.timestamp)}
                  </span>
                  {isOwnMessage && <span className="text-[10px]">{readByOther ? '✔✔' : '✔'}</span>}
                </div>
              </div>
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>

      <div className="p-2 border-t flex gap-2">
        <input
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder="Scrivi un messaggio..."
          className="flex-1 border p-2 rounded"
        />
        <button
          onClick={sendMessage}
          className="bg-blue-600 text-white px-4 py-1 rounded hover:bg-blue-700"
        >
          Invio
        </button>
      </div>
    </div>
  );
}