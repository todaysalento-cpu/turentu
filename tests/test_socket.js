'use client';

import { useEffect } from 'react';
import { io } from 'socket.io-client';

export default function TestSocket() {
  useEffect(() => {
    // Sostituisci con il token del tuo utente
    const token = sessionStorage.getItem('user')
      ? JSON.parse(sessionStorage.getItem('user')!).token
      : null;

    if (!token) return console.warn('🔹 Nessun token trovato per il test socket');

    const socket = io('http://localhost:3001', {
      transports: ['websocket'],
      auth: { token },
    });

    socket.on('connect', () => {
      console.log('🟢 Socket connesso per test');
    });

    // Questo log ti dirà tutto ciò che arriva dal server
    socket.on('new_notification', (n) => {
      console.log('🔔 Notifica ricevuta (test socket):', n);
    });

    socket.on('disconnect', () => {
      console.log('🔕 Socket disconnesso');
    });

    // Cleanup
    return () => {
      socket.disconnect();
    };
  }, []);

  return null;
}