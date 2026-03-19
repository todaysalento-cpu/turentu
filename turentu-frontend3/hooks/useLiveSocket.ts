// hooks/useLiveSocket.ts
import { useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';

const SOCKET_URL = 'http://localhost:3001';

export function useLiveSocket(user: any, corsaSelezionata: any) {
  const socketRef = useRef<Socket | null>(null);
  const typingTimeout = useRef<NodeJS.Timeout | null>(null);

  const [pending, setPending] = useState<any[]>([]);
  const [corseGiornata, setCorseGiornata] = useState<any[]>([]);
  const [chatMessages, setChatMessages] = useState<any[]>([]);
  const [chatTyping, setChatTyping] = useState(false);
  const [unreadCounts, setUnreadCounts] = useState<Record<number, number>>({});

  // ---- 1️⃣ Socket globale ----
  useEffect(() => {
    if (!user) return;
    const socket = io(SOCKET_URL, { withCredentials: true });
    socketRef.current = socket;

    // join global autista room
    socket.emit('join_autista', user.id);

    return () => {
      socket.disconnect();
    };
  }, [user]);

  // ---- 2️⃣ Listener globali: pending e corse ----
  useEffect(() => {
    const socket = socketRef.current;
    if (!socket) return;

    const handlePendingUpdate = (c: any) => {
      setPending(prev => {
        const exists = prev.find(p => p.id === c.id);
        return exists ? prev.map(p => p.id === c.id ? { ...p, ...c } : p) : [c, ...prev];
      });
    };

    const handleCorsaCreated = (c: any) => {
      if (!c?.veicolo_id) return;
      setCorseGiornata(prev => {
        const exists = prev.find(p => p.id === c.id);
        return exists ? prev.map(p => p.id === c.id ? { ...p, ...c } : p) : [...prev, c];
      });
    };

    socket.on('pending_update', handlePendingUpdate);
    socket.on('corsa_created', handleCorsaCreated);

    return () => {
      socket.off('pending_update', handlePendingUpdate);
      socket.off('corsa_created', handleCorsaCreated);
    };
  }, []);

  // ---- 3️⃣ Listener chat per corsa selezionata ----
  useEffect(() => {
    const socket = socketRef.current;
    if (!socket || !corsaSelezionata) return;

    // join chat room della corsa
    socket.emit('join_corsa_chat', corsaSelezionata.id);
    setUnreadCounts(prev => ({ ...prev, [corsaSelezionata.id]: 0 }));

    const handleNewMessage = (msg: any) => {
      if (msg.corsa_id === corsaSelezionata.id) {
        setChatMessages(prev => [...prev, msg]);
      } else {
        setUnreadCounts(prev => ({
          ...prev,
          [msg.corsa_id]: (prev[msg.corsa_id] || 0) + 1
        }));
      }
    };

    const handleTyping = (msg: any) => {
      if (msg.corsa_id === corsaSelezionata.id) {
        setChatTyping(true);
        if (typingTimeout.current) clearTimeout(typingTimeout.current);
        typingTimeout.current = setTimeout(() => setChatTyping(false), 1500);
      }
    };

    socket.on('new_message', handleNewMessage);
    socket.on('typing', handleTyping);

    return () => {
      socket.off('new_message', handleNewMessage);
      socket.off('typing', handleTyping);
      if (typingTimeout.current) clearTimeout(typingTimeout.current);
    };
  }, [corsaSelezionata]);

  // ---- 4️⃣ Funzioni ----
  const sendMessage = (corsaId: number, message: string, userId: number) => {
    const socket = socketRef.current;
    if (!socket || !message.trim()) return;
    socket.emit('send_message', { corsa_id: corsaId, user: userId, text: message });
  };

  const joinChat = (corsaId: number) => {
    const socket = socketRef.current;
    if (!socket) return;
    socket.emit('join_corsa_chat', corsaId);
    setUnreadCounts(prev => ({ ...prev, [corsaId]: 0 }));
  };

  return {
    socketRef,
    pending,
    setPending,
    corseGiornata,
    setCorseGiornata,
    chatMessages,
    setChatMessages,
    chatTyping,
    unreadCounts,
    sendMessage,
    joinChat,
  };
}