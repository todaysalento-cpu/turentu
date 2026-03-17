'use client';

import { createContext, useContext, useState, useCallback, ReactNode } from 'react';

// =====================
// Tipi
// =====================
export interface Participant {
  id: number;
  name: string;
  role: 'cliente' | 'autista';
}

export interface Message {
  id: string | number;
  corsa_id: number;
  cliente_id: number;
  sender_id: number;
  sender_name: string;
  role: 'cliente' | 'autista';
  text: string;
  timestamp: string;
  read_status: { autista: boolean; cliente: boolean };
}

export interface CorsaThread {
  corsa_id: number;
  cliente_id: number;
  origine?: string;
  destinazione?: string;
  participants: Participant[];
  messages: Message[];
  unreadCount: number;
  lastMessageTime?: string;
}

// =====================
// Context
// =====================
interface ChatContextType {
  threads: Record<string, CorsaThread>;
  activeThreadId: string | null;
  openThread: (corsa: CorsaThread, setActive?: boolean) => void;
  closeThread: (threadKey: string) => void;
  setActiveThread: (threadKey: string) => void;
  addMessage: (msg: Message, currentUserId: number, markUnread?: boolean) => void;
  markAsRead: (threadKey: string, role?: 'cliente' | 'autista') => void;
  updateUnreadCount: (threadKey: string, count: number | ((prev: number) => number)) => void;
  resetChat: () => void;
  getSortedThreads: () => CorsaThread[];
  getThreadsByCorsa: (corsa_id: number) => CorsaThread[];   // nuovo helper
  getClientsForCorsa: (corsa_id: number) => {
    cliente_id: number;
    name: string;
    threadKey: string;
    unreadCount: number;
  }[]; // nuovo helper
}

const ChatContext = createContext<ChatContextType | null>(null);

// =====================
// Provider
// =====================
export function ChatProvider({ children }: { children: ReactNode }) {
  const [threads, setThreads] = useState<Record<string, CorsaThread>>({});
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);

  const getThreadKey = (corsa_id: number, cliente_id: number) =>
    `${corsa_id}_${cliente_id}`;

  // =====================
  // OPEN THREAD
  // =====================
  const openThread = useCallback((corsa: CorsaThread, setActive = true) => {
    const key = getThreadKey(corsa.corsa_id, corsa.cliente_id);

    setThreads(prev => {
      const existing = prev[key];

      return {
        ...prev,
        [key]: existing
          ? {
              ...existing,
              origine: existing.origine || corsa.origine,
              destinazione: existing.destinazione || corsa.destinazione,
              participants: corsa.participants || existing.participants || [],
              messages: [...(existing.messages || []), ...(corsa.messages || [])],
              unreadCount: corsa.unreadCount ?? existing.unreadCount ?? 0,
              lastMessageTime:
                corsa.messages?.[corsa.messages.length - 1]?.timestamp ||
                existing.lastMessageTime
            }
          : {
              ...corsa,
              messages: corsa.messages || [],
              unreadCount: corsa.unreadCount || 0,
              lastMessageTime:
                corsa.messages?.[corsa.messages.length - 1]?.timestamp
            }
      };
    });

    if (setActive) setActiveThreadId(key);
  }, []);

  // =====================
  // SET ACTIVE THREAD
  // =====================
  const setActiveThread = useCallback((key: string) => {
    setActiveThreadId(key);
  }, []);

  // =====================
  // CLOSE THREAD
  // =====================
  const closeThread = useCallback((key: string) => {
    setThreads(prev => {
      const copy = { ...prev };
      delete copy[key];
      return copy;
    });

    setActiveThreadId(prev => (prev === key ? null : prev));
  }, []);

  const resetChat = useCallback(() => {
    setThreads({});
    setActiveThreadId(null);
  }, []);

  // =====================
  // ADD MESSAGE
  // =====================
  const addMessage = useCallback(
    (msg: Message, currentUserId: number, markUnread = true) => {
      const key = getThreadKey(msg.corsa_id, msg.cliente_id);

      setThreads(prev => {
        const thread = prev[key];
        if (!thread) return prev;

        if (thread.messages.some(m => m.id === msg.id)) return prev;

        const newMessages = [...thread.messages, msg];

        const unreadCount =
          markUnread && msg.sender_id !== currentUserId
            ? thread.unreadCount + 1
            : thread.unreadCount;

        return {
          ...prev,
          [key]: {
            ...thread,
            messages: newMessages,
            unreadCount,
            lastMessageTime: msg.timestamp
          }
        };
      });
    },
    []
  );

  // =====================
  // MARK AS READ
  // =====================
  const markAsRead = useCallback(
    (key: string, role?: 'cliente' | 'autista') => {
      if (!role) return;

      setThreads(prev => {
        const thread = prev[key];
        if (!thread) return prev;

        const updatedMessages = thread.messages.map(msg => ({
          ...msg,
          read_status: { ...msg.read_status, [role]: true }
        }));

        return {
          ...prev,
          [key]: {
            ...thread,
            messages: updatedMessages,
            unreadCount: 0
          }
        };
      });
    },
    []
  );

  // =====================
  // UPDATE UNREAD COUNT
  // =====================
  const updateUnreadCount = useCallback(
    (key: string, count: number | ((prev: number) => number)) => {
      setThreads(prev => {
        const thread = prev[key];
        if (!thread) return prev;

        const newCount =
          typeof count === 'function' ? count(thread.unreadCount) : count;

        return {
          ...prev,
          [key]: {
            ...thread,
            unreadCount: newCount
          }
        };
      });
    },
    []
  );

  // =====================
  // SORT THREADS
  // =====================
  const getSortedThreads = useCallback(() => {
    return Object.values(threads).sort((a, b) => {
      const tA = a.lastMessageTime ? new Date(a.lastMessageTime).getTime() : 0;
      const tB = b.lastMessageTime ? new Date(b.lastMessageTime).getTime() : 0;
      return tB - tA;
    });
  }, [threads]);

  // =====================
  // NEW HELPERS CORSE/CLIENTI
  // =====================
  const getThreadsByCorsa = useCallback(
    (corsa_id: number) => Object.values(threads).filter(t => t.corsa_id === corsa_id),
    [threads]
  );

  const getClientsForCorsa = useCallback(
    (corsa_id: number) =>
      getThreadsByCorsa(corsa_id).map(t => ({
        cliente_id: t.cliente_id,
        name: t.participants.find(p => p.id === t.cliente_id)?.name || `Cliente ${t.cliente_id}`,
        threadKey: `${t.corsa_id}_${t.cliente_id}`,
        unreadCount: t.unreadCount
      })),
    [getThreadsByCorsa]
  );

  return (
    <ChatContext.Provider
      value={{
        threads,
        activeThreadId,
        openThread,
        closeThread,
        setActiveThread,
        addMessage,
        markAsRead,
        updateUnreadCount,
        resetChat,
        getSortedThreads,
        getThreadsByCorsa,    // nuovo
        getClientsForCorsa    // nuovo
      }}
    >
      {children}
    </ChatContext.Provider>
  );
}

// =====================
// HOOK
// =====================
export function useChat() {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error('ChatContext missing');
  return ctx;
}