'use client';
import { useEffect, useState, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { useUser } from '../../../context/UserContext';
import { useSocket } from '../../../context/SocketProvider';

const ChatCorsa = dynamic(() => import('../../../components/ChatCorsa'), { ssr: false });

type Prenotazione = {
  id: number;
  corsaId: number;
  clienteId: number;
  status: 'confirmed' | 'pending' | string;
  prezzo: number;
  start_datetime?: string;
};

export default function PrenotazioniPage() {
  const { user } = useUser();
  const { socket } = useSocket();

  const [prenotazioni, setPrenotazioni] = useState<Prenotazione[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedPrenotazione, setSelectedPrenotazione] = useState<Prenotazione | null>(null);
  const [chatMessages, setChatMessages] = useState<Record<number, any[]>>({});
  const [unreadCounts, setUnreadCounts] = useState<Record<number, number>>({});

  // ================= HANDLE READ MESSAGES =================
  const handleReadMessages = useCallback((corsaId: number) => {
    setUnreadCounts(prev => ({ ...prev, [corsaId]: 0 }));
    fetch(`http://localhost:3001/chat/${corsaId}/read`, {
      method: 'POST',
      credentials: 'include'
    }).catch(console.error);
  }, []);

  // ================= SOCKET LISTENERS =================
  useEffect(() => {
    if (!socket) return;

    const handleNewMessage = (msg: any) => {
      setChatMessages(prev => ({
        ...prev,
        [msg.corsa_id]: [...(prev[msg.corsa_id] || []), msg],
      }));
      if (selectedPrenotazione?.corsaId === msg.corsa_id) handleReadMessages(msg.corsa_id);
    };

    const handleUnreadCount = ({ corsa_id, count }: { corsa_id: number; count: number }) => {
      setUnreadCounts(prev => ({ ...prev, [corsa_id]: count }));
    };

    socket.on('new_message', handleNewMessage);
    socket.on('unread_count', handleUnreadCount);

    return () => {
      socket.off('new_message', handleNewMessage);
      socket.off('unread_count', handleUnreadCount);
    };
  }, [socket, selectedPrenotazione, handleReadMessages]);

  // ================= JOIN / LEAVE ROOM =================
  useEffect(() => {
    if (!socket || !selectedPrenotazione) return;

    socket.emit('join_corsa_chat', selectedPrenotazione.corsaId);
    return () => {
      socket.emit('leave_corsa_chat', selectedPrenotazione.corsaId);
    };
  }, [socket, selectedPrenotazione]);

  // ================= FETCH MESSAGGI =================
  useEffect(() => {
    if (!selectedPrenotazione) return;

    const fetchMessages = async () => {
      try {
        const res = await fetch(`http://localhost:3001/chat/${selectedPrenotazione.corsaId}`, { credentials: 'include' });
        const msgs = await res.json();
        setChatMessages(prev => ({ ...prev, [selectedPrenotazione.corsaId]: msgs }));
      } catch (err: any) {
        console.error('Errore fetch messaggi:', err);
      }
    };

    fetchMessages();
  }, [selectedPrenotazione]);

  // ================= FETCH PRENOTAZIONI =================
  useEffect(() => {
    if (!user) return;

    const fetchPrenotazioni = async () => {
      try {
        const res = await fetch('http://localhost:3001/booking/cliente/prenotazioni', { credentials: 'include' });
        const data = await res.json();

        const prenotazioniList = Array.isArray(data.prenotazioni) ? data.prenotazioni : [];
        const pendingList = Array.isArray(data.pending) ? data.pending : [];

        const combined: Prenotazione[] = [
          ...prenotazioniList.map((p: any) => ({ ...p, status: 'confirmed' })),
          ...pendingList.map((p: any) => ({ ...p, status: p.status ?? 'pending' }))
        ];

        setPrenotazioni(combined);
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    };

    fetchPrenotazioni();
  }, [user]);

  if (!user) return <p className="mt-[60px] p-4 text-center">Devi essere loggato per vedere le tue prenotazioni.</p>;

  return (
    <div className="mt-[60px] p-4 max-w-4xl mx-auto relative">
      <h1 className="text-2xl font-bold mb-4">Le tue prenotazioni</h1>

      {loading && <p>Caricamento...</p>}

      {!loading && (
        <ul className="space-y-4">
          {prenotazioni.map(p => (
            <li key={`${p.status}_${p.id}`} className="p-4 border rounded flex justify-between items-center">
              <span className="font-semibold">Corsa #{p.corsaId}</span>
              {p.status === 'confirmed' && (
                <button
                  className="relative bg-blue-600 text-white px-3 py-1 rounded hover:bg-blue-700 transition"
                  onClick={() => setSelectedPrenotazione(p)}
                  disabled={!socket || !socket.connected}
                >
                  💬 Chat
                  {unreadCounts[p.corsaId] > 0 && (
                    <span className="absolute -top-1 -right-1 bg-red-500 text-xs w-5 h-5 flex items-center justify-center rounded-full">
                      {unreadCounts[p.corsaId]}
                    </span>
                  )}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* CHAT FLOTANTE */}
      {selectedPrenotazione && socket && (
        <div className="fixed bottom-4 right-4 w-[350px] h-[400px] bg-white border rounded-2xl shadow-xl flex flex-col overflow-hidden z-50">
          <div className="flex justify-between items-center px-4 py-2 bg-blue-600 text-white">
            <span className="font-semibold">{`Chat corsa #${selectedPrenotazione.corsaId}`}</span>
            <button
              className="text-white text-xl font-bold hover:opacity-80"
              onClick={() => setSelectedPrenotazione(null)}
            >
              ×
            </button>
          </div>

          <div className="flex-1 overflow-y-auto">
            <ChatCorsa
              corsaId={selectedPrenotazione.corsaId}
              socket={socket}
              userRole="Cliente"
              messages={chatMessages[selectedPrenotazione.corsaId] ?? []}
              onReadMessages={() => handleReadMessages(selectedPrenotazione.corsaId)}
            />
          </div>
        </div>
      )}
    </div>
  );
}