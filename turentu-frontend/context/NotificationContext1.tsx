'use client';

import { createContext, useContext, useState, useEffect, useRef, ReactNode, useCallback } from 'react';
import { useSocket } from './SocketProvider';
import { useUser } from './UserContext';

export type Notification = {
  id: number;
  type: 'pending' | 'info';
  message: string;
  seen?: boolean | string;
  created_at?: string;
  displayDate?: string;
};

type NotificationContextType = {
  notifications: Notification[];
  pendingCount: number;
  markAsSeen: (id: number) => void;
  refreshNotifications: () => void;
};

const NotificationContext = createContext<NotificationContextType>({
  notifications: [],
  pendingCount: 0,
  markAsSeen: () => {},
  refreshNotifications: () => {},
});

// 🔹 Formatta la data delle notifiche
const formatNotificationDate = (dateStr?: string) => {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return '';

  const now = new Date();
  const time = date.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });

  const isToday = date.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday = date.toDateString() === yesterday.toDateString();

  if (isToday) return `oggi alle ${time}`;
  if (isYesterday) return `ieri alle ${time}`;

  const dayName = date.toLocaleDateString('it-IT', { weekday: 'short', day: '2-digit', month: 'long' });
  return `${dayName} alle ${time}`;
};

export const NotificationProvider = ({ children }: { children: ReactNode }) => {
  const { user } = useUser();
  const { socket } = useSocket();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const storageKey = user?.id && user.role ? `notifications_${user.role}_${user.id}` : null;
  const saveTimeout = useRef<NodeJS.Timeout | null>(null);

  // 🔹 Normalizza notifiche: seen boolean, displayDate sempre valorizzato
  const normalizeNotifications = (notifs: Notification[]) =>
    Array.isArray(notifs)
      ? notifs.map(n => ({
          ...n,
          seen: n.seen === true || n.seen === 't',
          displayDate: n.displayDate || formatNotificationDate(n.created_at),
        }))
      : [];

  // 🔹 Mark as seen
  const markAsSeen = useCallback(async (id: number) => {
    setNotifications(prev => prev.map(n => (n.id === id ? { ...n, seen: true } : n)));

    try {
      await fetch('http://localhost:3001/notifications/mark-seen', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ id }),
      });
    } catch (err) {
      console.error('❌ Mark as seen error:', err);
    }
  }, []);

  // 🔹 Fetch notifiche dal server
  const refreshNotifications = useCallback(async () => {
    if (!user?.id) return;
    try {
      const res = await fetch('http://localhost:3001/notifications', { credentials: 'include' });
      const data: Notification[] = await res.json();
      setNotifications(normalizeNotifications(data));
    } catch (err) {
      console.error('❌ Refresh notifications error:', err);
    }
  }, [user?.id]);

  // 🔹 Carica da sessionStorage
  useEffect(() => {
    if (!storageKey) return;
    const stored = sessionStorage.getItem(storageKey);
    if (stored) {
      const initial = normalizeNotifications(JSON.parse(stored));
      setNotifications(initial);
    }
  }, [storageKey]);

  // 🔹 Salva su sessionStorage con debounce
  useEffect(() => {
    if (!storageKey) return;
    if (saveTimeout.current) clearTimeout(saveTimeout.current);
    saveTimeout.current = setTimeout(() => {
      sessionStorage.setItem(storageKey, JSON.stringify(notifications));
    }, 1000);
    return () => saveTimeout.current && clearTimeout(saveTimeout.current);
  }, [notifications, storageKey]);

  // 🔹 Socket: ricezione notifiche live
  useEffect(() => {
    if (!socket) return;
    const handler = (n: Notification) => {
      const normalized = {
        ...n,
        seen: n.seen === true || n.seen === 't',
        displayDate: n.displayDate || formatNotificationDate(n.created_at),
      };
      setNotifications(prev => (prev.some(e => e.id === normalized.id) ? prev : [normalized, ...prev]));
    };
    socket.on('new_notification', handler);
    return () => socket.off('new_notification', handler);
  }, [socket]);

  // 🔹 Polling fallback ogni 15s
  useEffect(() => {
    if (!user?.id) return;
    const interval = setInterval(refreshNotifications, 15_000);
    return () => clearInterval(interval);
  }, [refreshNotifications, user?.id]);

  const pendingCount = notifications.filter(n => n.type === 'pending' && !n.seen).length;

  return (
    <NotificationContext.Provider value={{ notifications, pendingCount, markAsSeen, refreshNotifications }}>
      {children}
    </NotificationContext.Provider>
  );
};

export const useNotifications = () => useContext(NotificationContext);