'use client';
import { useEffect, useState, useMemo, useCallback } from 'react';
import { useUser } from '../../../context/UserContext';
import { useSocket } from '../../../context/SocketProvider';
import CorseGiornata from '../../../components/CorseGiornata';
import ChatCorsa from '../../../components/ChatCorsa';
import dynamic from 'next/dynamic';

const Map = dynamic(() => import('../../../components/Map'), { ssr: false });

export default function LivePage() {
  const { user } = useUser();
  const { socket } = useSocket();

  const [corseGiornata, setCorseGiornata] = useState<any[]>([]);
  const [loadingId, setLoadingId] = useState<number | null>(null);
  const [corsaSelezionata, setCorsaSelezionata] = useState<any | null>(null);

  const [unreadCounts, setUnreadCounts] = useState<Record<number, number>>({});
  const [chatMessages, setChatMessages] = useState<Record<number, any[]>>({});

  // ================= SOCKET LISTENERS =================
  useEffect(() => {
    if (!socket) return;

    const handleNewMessage = (message: any) => {
      setChatMessages(prev => ({
        ...prev,
        [message.corsa_id]: [...(prev[message.corsa_id] || []), message]
      }));
    };

    const handleUnread = ({ corsa_id, count }: any) => {
      setUnreadCounts(prev => ({ ...prev, [corsa_id]: count }));
    };

    socket.on('new_message', handleNewMessage);
    socket.on('unread_count', handleUnread);

    return () => {
      socket.off('new_message', handleNewMessage);
      socket.off('unread_count', handleUnread);
    };
  }, [socket]);

  // ================= JOIN / LEAVE CHAT =================
  useEffect(() => {
    if (!socket || !corsaSelezionata) return;

    socket.emit('join_corsa_chat', corsaSelezionata.id);

    return () => {
      socket.emit('leave_corsa_chat', corsaSelezionata.id);
    };
  }, [socket, corsaSelezionata]);

  // ================= FETCH STORICO MESSAGGI =================
  useEffect(() => {
    if (!corsaSelezionata) return;

    const fetchMessages = async () => {
      try {
        const res = await fetch(`http://localhost:3001/chat/${corsaSelezionata.id}`, {
          credentials: 'include'
        });
        const data = await res.json();
        setChatMessages(prev => ({ ...prev, [corsaSelezionata.id]: data }));
      } catch (err) {
        console.error('Errore fetch messaggi:', err);
      }
    };

    fetchMessages();
  }, [corsaSelezionata]);

  // ================= READ MESSAGES =================
  const onReadMessages = useCallback((corsaId: number) => {
    setUnreadCounts(prev => prev[corsaId] ? { ...prev, [corsaId]: 0 } : prev);
    fetch(`http://localhost:3001/chat/${corsaId}/read`, { method: 'POST', credentials: 'include' })
      .catch(err => console.error(err));
  }, []);

  // ================= FETCH CORSE =================
  useEffect(() => {
    if (!user) return;

    const fetchCorse = async () => {
      try {
        const res = await fetch(`http://localhost:3001/corse/autista/today/${user.id}`, {
          credentials: 'include'
        });
        const data = await res.json();
        setCorseGiornata(Array.isArray(data) ? data : []);
      } catch (err) {
        console.error(err);
      }
    };

    fetchCorse();
  }, [user]);

  const corseFiltrate = useMemo(() => corseGiornata, [corseGiornata]);

  return (
    <div className="w-full max-w-[720px] mx-auto bg-white space-y-8 py-6">
      {/* CORSE */}
      <section>
        <h3 className="font-semibold mb-2">Corse della giornata</h3>
        <CorseGiornata
          corse={corseFiltrate}
          onToggleCorsa={(corsa) => setCorsaSelezionata(corsa)}
          loadingId={loadingId}
          unreadCounts={unreadCounts}
        />
      </section>

      {/* CHAT FLOTANTE IN BASSO TIPO UBER */}
      {corsaSelezionata && socket && (
        <div className="fixed bottom-4 right-4 w-[360px] h-[450px] bg-white border rounded-2xl shadow-xl flex flex-col overflow-hidden z-50">
          <div className="flex justify-between items-center px-4 py-2 bg-blue-600 text-white">
            <span className="font-semibold">{`Chat corsa #${corsaSelezionata.id}`}</span>
            <button
              className="text-white text-xl font-bold hover:opacity-80"
              onClick={() => setCorsaSelezionata(null)}
            >
              ×
            </button>
          </div>

          {corsaSelezionata.origine && corsaSelezionata.destinazione && (
            <div className="h-40 border-b">
              <Map
                origine={corsaSelezionata.origine}
                destinazione={corsaSelezionata.destinazione}
              />
            </div>
          )}

          <div className="flex-1 overflow-y-auto">
            <ChatCorsa
              corsaId={corsaSelezionata.id}
              socket={socket}
              userRole={user.role === 'autista' ? 'Autista' : 'Cliente'}
              messages={chatMessages[corsaSelezionata.id] ?? []}
              onReadMessages={() => onReadMessages(corsaSelezionata.id)}
            />
          </div>
        </div>
      )}
    </div>
  );
}