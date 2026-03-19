'use client';

import { createContext, useContext, useState, ReactNode, useEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { useUser } from './UserContext';

type SocketContextType = {
  socket: Socket | null;
  connecting: boolean;
};

const SocketContext = createContext<SocketContextType>({ socket: null, connecting: false });

export const SocketProvider = ({ children }: { children: ReactNode }) => {
  const { user, logout, loading } = useUser();
  const [socket, setSocket] = useState<Socket | null>(null);
  const [connecting, setConnecting] = useState(false);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    if (loading) return;

    // Disconnetti socket precedente se c'è
    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current = null;
      setSocket(null);
      setConnecting(false);
    }

    if (!user?.token) return;

    setConnecting(true);

    const SOCKET_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
    const s: Socket = io(SOCKET_URL, {
      transports: ['websocket'],
      auth: { token: user.token },
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 2000,
    });

    s.on('connect', () => {
      console.log('🟢 Socket connesso', s.id);
      setConnecting(false);
    });

    s.on('disconnect', (reason) => {
      console.log('🔴 Socket disconnesso', reason);
      setConnecting(false);
    });

    s.on('connect_error', async (err: any) => {
      console.error('❌ Socket connect_error:', err.message);
      if (err.message.includes('Authentication error')) await logout();
      setConnecting(false);
    });

    s.on('reconnect_attempt', (attempt) => console.log('🔄 Tentativo di reconnessione', attempt));
    s.on('reconnect_failed', () => {
      console.error('❌ Reconnect fallito');
      setConnecting(false);
    });

    socketRef.current = s;
    setSocket(s);

    return () => {
      s.disconnect();
      socketRef.current = null;
      setSocket(null);
      setConnecting(false);
    };
  }, [user?.token, loading, logout]);

  return (
    <SocketContext.Provider value={{ socket, connecting }}>
      {children}
    </SocketContext.Provider>
  );
};

export const useSocket = () => {
  const ctx = useContext(SocketContext);
  if (!ctx) throw new Error('useSocket deve essere usato dentro SocketProvider');
  return ctx;
};