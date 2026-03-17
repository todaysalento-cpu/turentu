'use client';

import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useSocket } from '../context/SocketProvider';
import { useChat, Message, CorsaThread } from '../context/ChatContext';
import { useUser } from '../context/UserContext';
import ChatCorsa from './ChatCorsa';

export default function ChatPanelPopup() {
  const { user } = useUser();
  const { threads, openThread, addMessage, activeThreadId, setActiveThread, getSortedThreads } = useChat();
  const { socket } = useSocket();

  const [text, setText] = useState('');
  const [searchText, setSearchText] = useState('');
  const [loadingThreads, setLoadingThreads] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const shouldScrollRef = useRef(true);

  const activeThread = activeThreadId ? threads[activeThreadId] : undefined;
  const messages = activeThread?.messages || [];

  const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

  // ====================
  // Fetch threads
  // ====================
  useEffect(() => {
    const fetchThreads = async () => {
      if (!user?.token) return;
      setLoadingThreads(true);
      setFetchError(null);
      try {
        const res = await fetch(`${API_URL}/chat/init`, {
          headers: { Authorization: `Bearer ${user.token}` },
        });
        if (!res.ok) throw new Error(`Errore fetch threads: ${res.statusText}`);
        const data: CorsaThread[] = await res.json();
        data.forEach(thread => openThread(thread));
      } catch (err: any) {
        console.error('Errore caricamento threads:', err);
        setFetchError(err.message);
      } finally {
        setLoadingThreads(false);
      }
    };
    fetchThreads();
  }, [user?.token, API_URL, openThread]);

  // ====================
  // Live messages & badge aggiornamento
  // ====================
  useEffect(() => {
    if (!socket) return;

    const newMessageHandler = (msg: Message) => {
      if (!threads[msg.corsa_id]) {
        openThread({
          id: msg.corsa_id,
          origine: 'Origine sconosciuta',
          destinazione: 'Destinazione sconosciuta',
          participants: [],
          messages: [],
          unreadCount: 0,
        });
      }

      const isOtherUser = msg.sender_id !== user?.id;
      addMessage(msg, isOtherUser);

      // Aggiorna badge per thread non attivo
      if (activeThreadId !== msg.corsa_id && isOtherUser) {
        const thread = threads[msg.corsa_id];
        if (thread) thread.unreadCount = (thread.unreadCount || 0) + 1;
      }
    };

    socket.on('new_message', newMessageHandler);
    return () => socket.off('new_message', newMessageHandler);
  }, [socket, threads, addMessage, openThread, user?.id, activeThreadId]);

  // ====================
  // Join/Leave room e reset unread
  // ====================
  useEffect(() => {
    if (!socket || !activeThread?.id) return;
    socket.emit('join_corsa_chat', activeThread.id);

    const initHandler = (msgs: Message[]) => {
      msgs.forEach(m => addMessage(m, m.sender_id !== user?.id));
      if (activeThread) activeThread.unreadCount = 0; // reset contatore
    };

    socket.on(`init_chat_${activeThread.id}`, initHandler);

    return () => {
      socket.off(`init_chat_${activeThread.id}`, initHandler);
      socket.emit('leave_corsa_chat', activeThread.id);
    };
  }, [socket, activeThread?.id, addMessage, user?.id]);

  // ====================
  // Scroll automatico
  // ====================
  const scrollToBottom = useCallback((smooth = true) => {
    messagesEndRef.current?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto' });
  }, []);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    shouldScrollRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
  };

  useEffect(() => {
    if (shouldScrollRef.current) {
      const id = setTimeout(() => scrollToBottom(), 50);
      return () => clearTimeout(id);
    }
  }, [messages, scrollToBottom]);

  // ====================
  // Send message
  // ====================
  const sendMessage = useCallback(() => {
    if (!text.trim() || !socket?.connected || !activeThread || !user) return;

    const tempMsg: Message = {
      id: `temp-${Date.now()}`,
      corsa_id: activeThread.id,
      sender_id: user.id,
      sender_name: user.role,
      role: user.role,
      text: text.trim(),
      timestamp: new Date().toISOString(),
      read_status: { autista: user.role === 'autista', cliente: user.role === 'cliente' },
    };

    addMessage(tempMsg, false);
    setText('');
    socket.emit('send_message', { corsa_id: activeThread.id, text: tempMsg.text });
  }, [text, socket, activeThread, addMessage, user]);

  // ====================
  // Format date
  // ====================
  const formatDate = (datetime?: string) => {
    if (!datetime) return 'Data sconosciuta';
    return new Date(datetime).toLocaleString('it-IT', {
      day: '2-digit',
      month: 'long',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  if (loadingThreads || fetchError || !user?.token) return null;

  // ====================
  // UI
  // ====================
  return (
    <div className="fixed top-[80px] bottom-5 right-5 w-[580px] border rounded-xl shadow-xl flex flex-col overflow-hidden z-50 bg-white">

      {/* Header */}
      <div className="px-4 py-2 bg-green-500 text-white font-semibold flex justify-between items-center">
        <span>Chat</span>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar corse */}
        <div className="w-2/5 bg-gray-100 border-r border-gray-300 flex flex-col">
          {/* Box ricerca */}
          <div className="p-2 border-b border-gray-300">
            <input
              type="text"
              placeholder="Cerca corsa..."
              value={searchText}
              onChange={e => setSearchText(e.target.value)}
              className="w-full px-2 py-1 text-[10px] rounded border focus:outline-none focus:ring-2 focus:ring-green-400"
            />
          </div>

          {/* Lista corse scrollabile */}
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {getSortedThreads()
              .filter(thread =>
                `${thread.origine} ${thread.destinazione}`.toLowerCase().includes(searchText.toLowerCase())
              )
              .map(thread => (
                <div
                  key={thread.id}
                  className={`p-2 cursor-pointer rounded-lg flex justify-between items-center hover:bg-gray-200 ${
                    activeThreadId === thread.id ? 'bg-gray-200 font-semibold' : ''
                  }`}
                  onClick={() => {
                    setActiveThread(thread.id);
                    thread.unreadCount = 0; // reset contatore al click
                  }}
                >
                  <div>
                    <div className="text-[11px]">{thread.origine} → {thread.destinazione}</div>
                    <div className="text-gray-500 text-[8px]">{formatDate(thread.start_datetime)}</div>
                  </div>
                  {thread.unreadCount > 0 && (
                    <span className="bg-red-500 text-white rounded-full w-5 h-5 flex items-center justify-center text-[8px]">
                      {thread.unreadCount}
                    </span>
                  )}
                </div>
              ))}
          </div>
        </div>

        {/* Chat */}
        <div className="flex-1 flex flex-col">
          {activeThread ? (
            <>
              {/* Chat header */}
              <div className="px-3 py-2 border-b border-gray-300 text-sm font-semibold">
                {activeThread.origine} → {activeThread.destinazione}
              </div>

              {/* Messages */}
              <div
                ref={containerRef}
                onScroll={handleScroll}
                className="flex-1 overflow-y-auto px-3 py-2 space-y-2 bg-gray-50 scrollbar-thin scrollbar-thumb-gray-400 scrollbar-track-gray-200"
              >
                {messages.length === 0 && (
                  <p className="text-gray-400 text-center text-sm mt-2">
                    {socket?.connected ? 'Nessun messaggio' : 'Connessione...'}
                  </p>
                )}
                <ChatCorsa messages={messages} />
                <div ref={messagesEndRef} />
              </div>

              {/* Input fisso */}
              <div className="px-3 py-2 border-t border-gray-300 flex gap-2 bg-white">
                <input
                  type="text"
                  value={text}
                  placeholder={socket?.connected ? 'Scrivi un messaggio...' : 'Connessione...'}
                  onChange={e => setText(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && sendMessage()}
                  className="flex-1 border rounded-full px-3 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-green-400"
                />
                <button
                  onClick={sendMessage}
                  disabled={!text.trim() || !socket?.connected}
                  className="bg-green-500 text-white px-3 py-1 rounded-full hover:bg-green-600 text-sm font-semibold disabled:opacity-50"
                >
                  Invia
                </button>
              </div>
            </>
          ) : (
            <div className="flex-1 flex justify-center items-center text-gray-400 text-sm">
              Seleziona una corsa per iniziare la chat
            </div>
          )}
        </div>
      </div>
    </div>
  );
}