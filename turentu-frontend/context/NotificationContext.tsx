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

// 🔹 Funzione di utilità per formattare la data
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

// 🔹 Normalizza le notifiche
const normalizeNotifications = (notifs: Notification[]) =>
  Array.isArray(notifs)
    ? notifs.map(n => ({
        ...n,
        seen: n.seen === true || n.seen === 't',
        displayDate: n.displayDate || formatNotificationDate(n.created_at),
      }))
    : [];

export const NotificationProvider = ({ children }: { children: ReactNode }) => {
  const { user } = useUser();
  const { socket } = useSocket();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const saveTimeout = useRef<NodeJS.Timeout | null>(null);

  const storageKey = user?.id && user.role ? `notifications_${user.role}_${user.id}` : null;

  // 🔹 Segna come lette
  const markAsSeen = useCallback(
    async (id: number) => {
      setNotifications(prev => prev.map(n => (n.id === id ? { ...n, seen: true } : n)));
      if (!user?.role) return;

      const url =
        user.role === 'admin'
          ? 'http://localhost:3001/admin/notifications/mark-seen'
          : 'http://localhost:3001/notifications/mark-seen';

      try {
        await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ id }),
        });
      } catch (err) {
        console.error('❌ Mark as seen error:', err);
      }
    },
    [user?.role]
  );

  // 🔹 Aggiorna notifiche dal server
  const refreshNotifications = useCallback(async () => {
    if (!user?.id) return;

    const url =
      user.role === 'admin'
        ? 'http://localhost:3001/admin/notifications'
        : 'http://localhost:3001/notifications';

    try {
      const res = await fetch(url, { credentials: 'include' });
      const data: Notification[] = await res.json();
      setNotifications(normalizeNotifications(data));
    } catch (err) {
      console.error('❌ Refresh notifications error:', err);
    }
  }, [user?.id, user?.role]);

  // 🔹 Carica notifiche da sessionStorage
  useEffect(() => {
    if (!storageKey) return;
    const stored = sessionStorage.getItem(storageKey);
    if (stored) setNotifications(normalizeNotifications(JSON.parse(stored)));
  }, [storageKey]);

  // 🔹 Salva notifiche in sessionStorage con debounce
  useEffect(() => {
    if (!storageKey) return;
    if (saveTimeout.current) clearTimeout(saveTimeout.current);

    saveTimeout.current = setTimeout(() => {
      sessionStorage.setItem(storageKey, JSON.stringify(notifications));
    }, 1000);

    return () => saveTimeout.current && clearTimeout(saveTimeout.current);
  }, [notifications, storageKey]);

  // 🔹 Socket: notifiche live
  useEffect(() => {
    if (!socket || !user?.role || !user?.id) return;

    const socketRoom = `${user.role}_${user.id}`;
    const handler = (notif: Notification) => {
      const normalized = { ...notif, seen: notif.seen === true || notif.seen === 't', displayDate: notif.displayDate || formatNotificationDate(notif.created_at) };
      setNotifications(prev => (prev.some(n => n.id === normalized.id) ? prev : [normalized, ...prev]));
    };

    socket.on('new_notification', handler);
    return () => socket.off('new_notification', handler);
  }, [socket, user?.role, user?.id]);

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