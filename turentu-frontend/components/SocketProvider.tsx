'use client';

import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { io, Socket } from 'socket.io-client';
import { useUser } from './UserContext';
import { Notification, useNotifications } from './NotificationContext';

type SocketContextType = {
  socket: Socket | null;
};

const SocketContext = createContext<SocketContextType>({ socket: null });

export const SocketProvider = ({ children }: { children: ReactNode }) => {
  const { user } = useUser();
  const [socket, setSocket] = useState<Socket | null>(null);
  const { setNotifications } = useNotifications() as any; // hook NotificationContext

  useEffect(() => {
    if (!user?.id || !user.token) {
      // disconnetti se non c'è utente o token
      socket?.disconnect();
      setSocket(null);
      return;
    }

    // connetti
    const s = io('http://localhost:3001', {
      auth: { token: user.token },
      transports: ['websocket'],
    });

    console.log('🔎 Socket connesso con token:', user.token ? 'SÌ' : 'NO');

    s.on('connect', () => console.log('🟢 Socket connesso', s.id));
    s.on('disconnect', () => console.log('🔴 Socket disconnesso'));

    // gestione notifiche live
    s.on('new_notification', (n: Notification) => {
      setNotifications((prev: Notification[]) => {
        if (prev.some((e) => e.id === n.id)) return prev;
        return [n, ...prev];
      });
    });

    setSocket(s);

    return () => s.disconnect();
  }, [user?.id, user?.token]);

  return <SocketContext.Provider value={{ socket }}>{children}</SocketContext.Provider>;
};

export const useSocket = () => useContext(SocketContext);