'use client';

import React, { useEffect, useState } from 'react';
import { useChat } from '../context/ChatContext';
import { useSocket } from '../context/SocketProvider';

export default function ChatList() {
  const { openChat, corsa } = useChat();
  const { socket } = useSocket();
  const [threads, setThreads] = useState<any[]>([]);

  // Fetch threads dal backend
  useEffect(() => {
    async function fetchThreads() {
      const res = await fetch('/chat/threads');
      const data = await res.json();
      setThreads(data);
    }
    fetchThreads();
  }, []);

  // Socket updates in tempo reale
  useEffect(() => {
    if (!socket) return;

    const handleNewMessage = (msg: any) => {
      setThreads(prev =>
        prev.map(t => t.id === msg.corsa_id ? { ...t, lastMessage: msg } : t)
      );
    };

    socket.on('new_message', handleNewMessage);
    return () => socket.off('new_message', handleNewMessage);
  }, [socket]);

  return (
    <div className="flex flex-col border-r border-gray-200 w-64 h-full overflow-y-auto">
      {threads.map(thread => (
        <div
          key={thread.id}
          className="px-4 py-3 hover:bg-gray-100 cursor-pointer"
          onClick={() => openChat(thread)}
        >
          <div className="font-semibold">{thread.origine} → {thread.destinazione}</div>
          <div className="text-xs text-gray-500">
            {thread.lastMessage ? `${thread.lastMessage.sender_name}: ${thread.lastMessage.text}` : 'Nessun messaggio'}
          </div>
        </div>
      ))}
    </div>
  );
}