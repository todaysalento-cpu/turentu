'use client';

import React from 'react';
import { Message } from '../context/ChatContext';

interface ChatCorsaProps {
  messages: Message[];
  currentUserRole?: 'cliente' | 'autista';
}

export default function ChatCorsa({ messages, currentUserRole = 'autista' }: ChatCorsaProps) {

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

  return (
    <div className="flex flex-col space-y-2">
      {messages.map((msg, index) => {
        const role = msg.role?.toLowerCase() || 'cliente';
        const isAutista = role === 'autista';
        const isOwnMessage = role === currentUserRole;
        const isTemp = typeof msg.id === 'string' && msg.id.startsWith('temp-');

        // Stato lettura doppio check
        const readByOther = isOwnMessage && (
          currentUserRole === 'autista' ? msg.read_status.cliente : msg.read_status.autista
        );

        return (
          <div
            key={`${msg.id}-${index}`} 
            className={`flex ${isAutista ? 'justify-start' : 'justify-end'}`}
          >
            <div
              className={`
                max-w-[70%] px-3 py-2 rounded-xl text-sm
                ${isAutista ? 'bg-gray-200 text-gray-900 rounded-tl-none' : 'bg-green-500 text-white rounded-tr-none'}
                ${isTemp ? 'opacity-70 italic' : ''}
                relative
              `}
              title={formatFullDate(msg.timestamp)} // tooltip timestamp completo
            >
              <div>{msg.text || ''}</div>
              <div className={`text-[9px] mt-1 flex items-center justify-end space-x-1`}>
                <span className={isAutista ? 'text-gray-500' : 'text-gray-200'}>
                  {formatTime(msg.timestamp)}
                </span>
                {isOwnMessage && (
                  <span className="text-[10px]">
                    {readByOther ? '✔✔' : '✔'}
                  </span>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}