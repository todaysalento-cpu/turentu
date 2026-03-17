'use client';
import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { io, Socket } from 'socket.io-client';

interface Notifications {
  prenotazioni: number;
  corse: number;
  pagamenti: number;
}

interface NotificationContextType {
  notifications: Notifications;
  resetNotification: (type: keyof Notifications) => void;
}

const NotificationContext = createContext<NotificationContextType>({
  notifications: { prenotazioni: 0, corse: 0, pagamenti: 0 },
  resetNotification: () => {},
});

export const useNotifications = () => useContext(NotificationContext);

export function NotificationProvider({ children }: { children: ReactNode }) {
  const [notifications, setNotifications] = useState<Notifications>({ prenotazioni: 0, corse: 0, pagamenti: 0 });

  useEffect(() => {
    const socket: Socket = io('http://localhost:3001');

    socket.on('notifications', (data: Notifications) => {
      setNotifications(data);
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  const resetNotification = (type: keyof Notifications) => {
    setNotifications((prev) => ({ ...prev, [type]: 0 }));
  };

  return (
    <NotificationContext.Provider value={{ notifications, resetNotification }}>
      {children}
    </NotificationContext.Provider>
  );
}
