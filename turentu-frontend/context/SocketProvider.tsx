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

  // Ref per mantenere l'istanza attuale del socket
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    console.log('🔌 [SocketProvider] Effect trigger', { user, loading, socketExists: !!socketRef.current });

    // Se l'utente sta ancora caricando, aspetta
    if (loading) {
      console.log('⏳ [SocketProvider] User loading, sospendo creazione socket');
      return;
    }

    // Se non c'è token, chiudi eventuale socket precedente
    if (!user?.token) {
      console.log('❌ [SocketProvider] Nessun token, socket non creato');
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
        setSocket(null);
        setConnecting(false);
      }
      return;
    }

    // Se c'è già un socket attivo, disconnettilo prima di crearne uno nuovo
    if (socketRef.current) {
      console.log('🧹 [SocketProvider] Disconnect previous socket');
      socketRef.current.disconnect();
      socketRef.current = null;
      setSocket(null);
      setConnecting(false);
    }

    console.log('🔔 [SocketProvider] Creo socket per utente', user.id);
    setConnecting(true);

    const s: Socket = io('http://localhost:3001', {
      transports: ['websocket'],
      auth: { token: user.token },
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 2000,
    });

    // Eventi socket
    s.on('connect', () => {
      console.log('🟢 [SocketProvider] Socket connesso', { socketId: s.id });
      setConnecting(false);
    });

    s.on('disconnect', (reason) => {
      console.log('🔴 [SocketProvider] Socket disconnesso', { reason });
      setConnecting(false);
    });

    s.on('connect_error', async (err: any) => {
      console.error('❌ [SocketProvider] Socket connect_error:', err.message);
      if (err.message.includes('Authentication error')) {
        console.error('🔑 Token non valido, eseguo logout');
        await logout();
      }
      setConnecting(false);
    });

    s.on('reconnect_attempt', (attempt) => {
      console.log('🔄 [SocketProvider] Tentativo di reconnessione', attempt);
    });

    s.on('reconnect_failed', () => {
      console.error('❌ [SocketProvider] Reconnect socket fallito');
      setConnecting(false);
    });

    // Salva nel ref e nello state
    socketRef.current = s;
    setSocket(s);

    // Cleanup al dismount o al cambio token
    return () => {
      console.log('🧹 [SocketProvider] Cleanup socket');
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