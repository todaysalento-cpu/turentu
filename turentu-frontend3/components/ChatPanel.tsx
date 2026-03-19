'use client';

import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useSocket } from '../context/SocketProvider';
import { useChat, Message, Thread } from '../context/ChatContext';
import { useUser, User } from '../context/UserContext';
import ChatCorsa from './ChatCorsa';

type ThreadsByCorsa = Record<number, Thread[]>;

export default function ChatPanelPopup() {
  const { user } = useUser();
  const { threads, openThread, addMessage, activeThreadId, setActiveThread, updateUnreadCount } = useChat();
  const { socket } = useSocket();

  const [text, setText] = useState('');
  const [searchText, setSearchText] = useState('');
  const [loadingThreads, setLoadingThreads] = useState(true);
  const [selectedCorsaId, setSelectedCorsaId] = useState<number | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const shouldScrollRef = useRef(true);

  const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
  const activeMessages: Message[] = activeThreadId ? threads[activeThreadId]?.messages ?? [] : [];

  const incrementUnreadCount = useCallback(
    (key: string) => {
      updateUnreadCount(key, (prev) => (prev ?? 0) + 1);
    },
    [updateUnreadCount]
  );

  const threadsByCorsa: ThreadsByCorsa = Object.values(threads).reduce((acc: ThreadsByCorsa, thread) => {
    const corsaId = thread.corsa_id ?? 0;
    if (!acc[corsaId]) acc[corsaId] = [];
    acc[corsaId].push(thread);
    return acc;
  }, {});

  useEffect(() => {
    if (!user?.token) return;

    const fetchThreads = async () => {
      try {
        const res = await fetch(`${API_URL}/chat/init`, { headers: { Authorization: `Bearer ${user.token}` } });
        const data = await res.json();
        const threadsData: any[] = Array.isArray(data) ? data : [];

        threadsData.forEach((thread: any) => {
          const unreadCount =
            thread.unreadCount ??
            (thread.messages?.filter((m: Message) =>
              m.sender_id !== user.id && !(m.read_status?.[user.role?.toLowerCase() ?? 'cliente'])
            ).length ?? 0);

          openThread(
            {
              corsa_id: thread.corsa_id ?? 0,
              cliente_id: thread.cliente_id ?? 0,
              origine: thread.origine ?? 'Origine',
              destinazione: thread.destinazione ?? 'Destinazione',
              start_datetime: thread.start_datetime ?? undefined,
              participants: thread.participants ?? [],
              messages: thread.messages ?? [],
              unreadCount,
              lastMessageTime: thread.messages?.length ? thread.messages[thread.messages.length - 1].timestamp : undefined
            },
            false
          );
        });
      } catch (err) {
        console.error('Errore fetch chat:', err);
      } finally {
        setLoadingThreads(false);
      }
    };

    fetchThreads();
  }, [user?.token, openThread]);

  useEffect(() => {
    if (!socket || !user) return;

    const handler = (msg: Message) => {
      const key = `${msg.corsa_id}_${msg.cliente_id}`;
      if (!threads[key]) {
        openThread(
          {
            corsa_id: msg.corsa_id,
            cliente_id: msg.cliente_id,
            origine: 'Origine',
            destinazione: 'Destinazione',
            start_datetime: new Date().toISOString(),
            participants: [],
            messages: [],
            unreadCount: 0
          },
          false
        );
      }

      const isOtherUser = msg.sender_id !== user.id;
      addMessage(msg, user.id, isOtherUser);

      if (isOtherUser && activeThreadId !== key) incrementUnreadCount(key);
      if (activeThreadId === key) shouldScrollRef.current = true;
    };

    socket.on('new_message', handler);
    return () => socket.off('new_message', handler);
  }, [socket, user, threads, activeThreadId, addMessage, incrementUnreadCount, openThread]);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    if (shouldScrollRef.current) setTimeout(scrollToBottom, 50);
  }, [activeMessages, scrollToBottom]);

  const sendMessage = () => {
    if (!text.trim() || !socket?.connected || !activeThreadId || !user) return;
    const thread = threads[activeThreadId];
    if (!thread) return;

    const role = user.role?.toLowerCase() as 'cliente' | 'autista';

    const msg: Message = {
      id: `temp-${Date.now()}`,
      corsa_id: thread.corsa_id,
      cliente_id: thread.cliente_id,
      sender_id: user.id,
      sender_name: user.role ?? 'utente',
      role,
      text: text.trim(),
      timestamp: new Date().toISOString(),
      read_status: { autista: role === 'autista', cliente: role === 'cliente' }
    };

    addMessage(msg, user.id, false);
    socket.emit('send_message', { corsa_id: thread.corsa_id, cliente_id: thread.cliente_id, text: msg.text });
    setText('');
    shouldScrollRef.current = true;
  };

  const formatDate = (datetime?: string) => {
    if (!datetime) return '';
    return new Date(datetime).toLocaleString('it-IT', { day: '2-digit', month: 'long', hour: '2-digit', minute: '2-digit' });
  };

  if (!user || loadingThreads) return null;

  const isAutista = user.role === 'autista';

  return (
    <div className="fixed top-[80px] bottom-5 right-5 w-[640px] border rounded-xl shadow-xl flex flex-col overflow-hidden z-50 bg-white">
      <div className="px-4 py-2 bg-green-500 text-white font-semibold">Chat</div>
      <div className="flex flex-1 overflow-hidden">
        {/* SIDEBAR */}
        <div className="w-2/5 bg-gray-50 border-r border-gray-200 flex flex-col">
          <div className="p-2 border-b border-gray-200 flex flex-col gap-1">
            {!selectedCorsaId ? (
              <input
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                placeholder="Cerca corsa..."
                className="w-full px-2 py-1 text-sm rounded border border-gray-300 focus:outline-none focus:ring-1 focus:ring-green-400"
              />
            ) : (
              isAutista &&
              threadsByCorsa[selectedCorsaId]?.[0] && (
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setSelectedCorsaId(null)}
                    className="w-8 h-8 flex items-center justify-center bg-gray-100 hover:bg-gray-200 rounded-full text-gray-600 transition-colors"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                    </svg>
                  </button>
                  {/* BOX CORSA SELEZIONATA */}
                  <div className="flex items-center gap-2 p-2 bg-gray-50 cursor-pointer">
                    <div className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-semibold text-white flex-shrink-0 bg-gray-400">
                      🚗
                    </div>
                    <div className="flex-1 flex flex-col justify-center leading-tight">
                      <span className="text-sm font-medium truncate">
                        {threadsByCorsa[selectedCorsaId][0].origine.split(',')[0]} →{' '}
                        {threadsByCorsa[selectedCorsaId][0].destinazione.split(',')[0]}
                      </span>
                      <span className="text-[10px] text-gray-500 truncate">
                        {formatDate(threadsByCorsa[selectedCorsaId][0].start_datetime)}
                      </span>
                    </div>
                    {threadsByCorsa[selectedCorsaId][0].unreadCount > 0 && (
                      <span className="bg-red-500 text-white rounded-full w-4 h-4 flex items-center justify-center text-[8px] flex-shrink-0">
                        {threadsByCorsa[selectedCorsaId][0].unreadCount}
                      </span>
                    )}
                  </div>
                </div>
              )
            )}
          </div>

          {/* LISTA CLIENTI */}
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {!selectedCorsaId &&
              Object.keys(threadsByCorsa)
                .filter((corsaId) => {
                  const t = threadsByCorsa[Number(corsaId)][0];
                  return (
                    t.origine.toLowerCase().includes(searchText.toLowerCase()) ||
                    t.destinazione.toLowerCase().includes(searchText.toLowerCase())
                  );
                })
                .map((corsaId) => {
                  const threadGroup = threadsByCorsa[Number(corsaId)];
                  const totalUnread = threadGroup.reduce((sum, t) => sum + (t.unreadCount ?? 0), 0);
                  const thread = threadGroup[0];
                  return (
                    <div
                      key={corsaId}
                      onClick={() =>
                        isAutista
                          ? setSelectedCorsaId(Number(corsaId))
                          : setActiveThread(`${thread.corsa_id}_${thread.cliente_id}`)
                      }
                      className="p-2 hover:bg-gray-50 rounded flex justify-between items-center cursor-pointer transition-colors"
                    >
                      <div>
                        <div className="text-xs font-medium">
                          {thread.origine} → {thread.destinazione}
                        </div>
                        <div className="text-[10px] text-gray-500">{formatDate(thread.start_datetime)}</div>
                      </div>
                      {totalUnread > 0 && (
                        <span className="bg-red-500 text-white rounded-full w-5 h-5 flex items-center justify-center text-[9px]">
                          {totalUnread}
                        </span>
                      )}
                    </div>
                  );
                })}

            {isAutista &&
              selectedCorsaId &&
              threadsByCorsa[selectedCorsaId]?.map((thread) => {
                const key = `${thread.corsa_id}_${thread.cliente_id}`;
                const participant = thread.participants.find((p) => p.id === thread.cliente_id);
                const participantName = participant?.name ?? `Cliente ${thread.cliente_id}`;
                const avatarText = participantName
                  .split(' ')
                  .map((n) => n[0])
                  .join('')
                  .slice(0, 2)
                  .toUpperCase();
                const colors = ['#f87171', '#fbbf24', '#34d399', '#60a5fa', '#a78bfa', '#f472b6', '#facc15'];
                const avatarColor =
                  colors[participantName.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0) % colors.length];

                return (
                  <div
                    key={key}
                    onClick={() => setActiveThread(key)}
                    className={`p-2 rounded flex items-center gap-2 ${
                      activeThreadId === key ? 'bg-gray-100' : 'hover:bg-gray-50'
                    } transition-colors cursor-pointer`}
                  >
                    <div
                      className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-semibold text-white flex-shrink-0"
                      style={{ backgroundColor: avatarColor }}
                    >
                      {avatarText}
                    </div>
                    <span className="text-sm font-medium flex-1 truncate">{participantName}</span>
                    {thread.unreadCount > 0 && (
                      <span className="bg-red-500 text-white rounded-full w-4 h-4 flex items-center justify-center text-[8px] flex-shrink-0">
                        {thread.unreadCount}
                      </span>
                    )}
                  </div>
                );
              })}
          </div>
        </div>

        {/* CHAT AREA */}
        <div className="flex-1 flex flex-col">
          {activeThreadId && threads[activeThreadId] ? (
            <>
              <div className="flex items-center gap-2 p-2 border-b border-gray-200 bg-gray-50">
                <div
                  className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-semibold text-white flex-shrink-0"
                  style={{
                    backgroundColor: (() => {
                      const participant =
                        threads[activeThreadId].participants.find(
                          (p) => p.id === threads[activeThreadId].cliente_id
                        ) || { name: `Cliente ${threads[activeThreadId].cliente_id}` };
                      const colors = ['#f87171', '#fbbf24', '#34d399', '#60a5fa', '#a78bfa', '#f472b6', '#facc15'];
                      return colors[participant.name.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0) % colors.length];
                    })(),
                  }}
                >
                  {(() => {
                    const participant =
                      threads[activeThreadId].participants.find(
                        (p) => p.id === threads[activeThreadId].cliente_id
                      ) || { name: `Cliente ${threads[activeThreadId].cliente_id}` };
                    return participant.name.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase();
                  })()}
                </div>
                <span className="text-sm font-medium truncate">
                  {threads[activeThreadId].participants.find((p) => p.id === threads[activeThreadId].cliente_id)
                    ?.name ?? `Cliente ${threads[activeThreadId].cliente_id}`}
                </span>
                {threads[activeThreadId].unreadCount > 0 && (
                  <span className="bg-red-500 text-white rounded-full w-4 h-4 flex items-center justify-center text-[8px] flex-shrink-0">
                    {threads[activeThreadId].unreadCount}
                  </span>
                )}
              </div>

              <div className="flex-1 overflow-y-auto px-3 py-2 bg-gray-50">
                <ChatCorsa messages={activeMessages} currentUserRole={(user.role?.toLowerCase() as 'cliente' | 'autista') ?? 'cliente'} />
                <div ref={messagesEndRef} />
              </div>

              <div className="px-3 py-2 border-t border-gray-200 flex gap-2 bg-gray-50">
                <input
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && sendMessage()}
                  className="flex-1 border rounded-full px-3 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-green-400"
                  placeholder="Scrivi un messaggio..."
                />
                <button onClick={sendMessage} className="bg-green-500 text-white px-3 py-1 rounded-full">
                  Invia
                </button>
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">Seleziona una chat</div>
          )}
        </div>
      </div>
    </div>
  );
}