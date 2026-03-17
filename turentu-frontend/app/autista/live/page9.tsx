'use client';

import { useEffect, useState, useMemo, useRef, useCallback } from 'react';
import { useUser } from '../../../context/UserContext';
import PendingList from '../../../components/PendingList';
import CorseGiornata from '../../../components/CorseGiornata';
import ChatCorsa from '../../../components/ChatCorsa';
import { CarIcon } from 'lucide-react';
import dynamic from 'next/dynamic';
import { io, Socket } from 'socket.io-client';

const SOCKET_URL = 'http://localhost:3001';
const Map = dynamic(() => import('../../../components/Map'), { ssr: false });

export default function LivePage() {
  const { user } = useUser();

  const [veicoli, setVeicoli] = useState<any[]>([]);
  const [selectedVeicoloId, setSelectedVeicoloId] = useState<number | null>(null);
  const [pending, setPending] = useState<any[]>([]);
  const [corseGiornata, setCorseGiornata] = useState<any[]>([]);
  const [loadingId, setLoadingId] = useState<number | null>(null);
  const [disponibilita, setDisponibilita] = useState<any[]>([]);
  const [corsaSelezionata, setCorsaSelezionata] = useState<any | null>(null);
  const [unreadCounts, setUnreadCounts] = useState<Record<number, number>>({});
  const [chatMessages, setChatMessages] = useState<Record<number, any[]>>({});
  const [socketConnected, setSocketConnected] = useState(false);

  const socketRefChat = useRef<Socket | null>(null);

  // ---------- SOCKET CHAT ----------
  useEffect(() => {
    if (!user || socketRefChat.current) return;

    const socket = io(SOCKET_URL, { withCredentials: true, auth: { token: user.token } });
    socketRefChat.current = socket;

    socket.on('connect', () => setSocketConnected(true));
    socket.on('disconnect', () => setSocketConnected(false));
    socket.on('new_message', (message: any) => {
      setChatMessages(prev => ({
        ...prev,
        [message.corsa_id]: [...(prev[message.corsa_id] || []), message]
      }));
      setUnreadCounts(prev => ({
        ...prev,
        [message.corsa_id]: (prev[message.corsa_id] || 0) + 1
      }));
    });
    socket.on('unread_count', ({ corsa_id, count }: { corsa_id: number; count: number }) => {
      setUnreadCounts(prev => ({ ...prev, [corsa_id]: count }));
    });

    return () => {
      socket.disconnect();
      socketRefChat.current = null;
    };
  }, [user]);

  // ---------- JOIN / LEAVE CHAT ----------
  useEffect(() => {
    const socket = socketRefChat.current;
    if (!socket || !corsaSelezionata) return;
    socket.emit('join_corsa_chat', corsaSelezionata.id);
    return () => socket.emit('leave_corsa_chat', corsaSelezionata.id);
  }, [corsaSelezionata?.id]);

  // ---------- FETCH MESSAGGI ----------
  useEffect(() => {
    if (!corsaSelezionata) return;
    (async () => {
      try {
        const res = await fetch(`http://localhost:3001/chat/${corsaSelezionata.id}`, { credentials: 'include' });
        const data = await res.json();
        setChatMessages(prev => ({ ...prev, [corsaSelezionata.id]: data }));
      } catch (err) { console.error('Errore fetch messaggi:', err); }
    })();
  }, [corsaSelezionata?.id]);

  // ---------- ON READ MESSAGES ----------
  const onReadMessages = useCallback((corsaId: number) => {
    setUnreadCounts(prev => ({ ...prev, [corsaId]: 0 }));
    fetch(`http://localhost:3001/chat/${corsaId}/read`, { method: 'POST', credentials: 'include' })
      .catch(err => console.error('Errore marking messages as read:', err));
  }, []);

  // ---------- FETCH INIZIALI ----------
  useEffect(() => {
    if (!user) return;
    (async () => {
      try {
        const [resG, resV, resD] = await Promise.all([
          fetch(`http://localhost:3001/corse/autista/today/${user.id}`, { credentials: 'include' }),
          fetch(`http://localhost:3001/veicolo`, { credentials: 'include' }),
          fetch(`http://localhost:3001/disponibilita`, { credentials: 'include' }),
        ]);
        const [dataG, dataV, dataD] = await Promise.all([resG.json(), resV.json(), resD.json()]);

        setCorseGiornata(Array.isArray(dataG) ? dataG.filter(c => c.veicolo_id != null) : []);
        setVeicoli(Array.isArray(dataV) ? dataV : []);
        setDisponibilita(Array.isArray(dataD) ? dataD : []);
        if (Array.isArray(dataV) && dataV.length > 0) setSelectedVeicoloId(dataV[0].id);
      } catch (err) { console.error(err); }
    })();
  }, [user]);

  // ---------- FETCH PENDING ----------
  useEffect(() => {
    if (!user || !selectedVeicoloId) return;
    (async () => {
      try {
        const res = await fetch(`http://localhost:3001/pending/autista/${selectedVeicoloId}`, { credentials: 'include' });
        const data = await res.json();
        setPending(Array.isArray(data?.pendings) ? data.pendings : []);
      } catch (err) { console.error(err); }
    })();
  }, [user, selectedVeicoloId]);

  // ---------- GESTIONE CORSA ----------
  const handleAccetta = async (id: number) => {
    if (loadingId) return;
    try {
      setLoadingId(id);
      const res = await fetch(`http://localhost:3001/pending/${id}/accetta`, { method: 'POST', credentials: 'include' });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setPending(prev => prev.filter(p => p.id !== id));
      if (data.corsa) setCorseGiornata(prev => [...prev, data.corsa]);
    } catch (err: any) { alert(err.message); } finally { setLoadingId(null); }
  };

const handleToggleCorsa = async (corsa: any) => {
  if (loadingId) return;

  try {
    setLoadingId(corsa.id);

    // Determina l'endpoint: 'start' per iniziare, 'end' per terminare
    const endpoint = corsa.stato === 'in_corso' ? 'end' : 'start';

    const res = await fetch(`http://localhost:3001/corse/${corsa.id}/${endpoint}`, {
      method: 'POST',
      credentials: 'include'
    });

    if (!res.ok) {
      alert(`Errore ${endpoint} corsa: ${await res.text()}`);
      return;
    }

    const data = await res.json();
    const corsaAggiornata = data.corsa || data.nuovaCorsa || corsa;

    // Aggiorna corseGiornata con il nuovo stato dal backend
    setCorseGiornata(prev =>
      prev.map(c => (c.id === corsa.id ? { ...c, ...corsaAggiornata } : c))
    );

    // Gestione chat: apertura se in corso o appena terminata per mostrare pagamenti
    if (endpoint === 'start' || endpoint === 'end') {
      setCorsaSelezionata({ ...corsa, ...corsaAggiornata });
    }

    // Mostra dettagli pagamenti catturati se corsa terminata
    if (endpoint === 'end') {
      if (corsaAggiornata.pagamentiCatturati?.length) {
        const msg = corsaAggiornata.pagamentiCatturati
          .map((p: any) => `Prenotazione #${p.prenotazione_id}: €${p.importo.toFixed(2)} → ${p.stato}`)
          .join('\n');
        alert(`Corsa completata!\n\nPagamenti:\n${msg}`);
      } else {
        alert('Corsa completata e pagamenti catturati.');
      }
    }

  } catch (err: any) {
    alert(err.message);
  } finally {
    setLoadingId(null);
  }
};
  // ---------- RENDER ----------
  const selectedVeicolo = veicoli.find(v => v.id === selectedVeicoloId);
  const corseFiltrate = useMemo(() => corseGiornata.filter(c => c.veicolo_id === selectedVeicoloId), [corseGiornata, selectedVeicoloId]);

  return (
    <div className="w-full max-w-[720px] mx-auto bg-white space-y-8 py-6">
      {/* Selezione veicolo */}
      <section className="space-y-4">
        <div className="flex items-center gap-3">
          <h2 className="text-[14px] font-semibold whitespace-nowrap">Selezione veicolo</h2>
          <select
            value={selectedVeicoloId || ''}
            onChange={e => setSelectedVeicoloId(Number(e.target.value))}
            className="w-[160px] border border-gray-300 rounded-md px-2 py-1 text-[13px]"
          >
            {veicoli.map(v => <option key={v.id} value={v.id}>{v.modello}</option>)}
          </select>
        </div>
        {selectedVeicolo && <div className="flex items-center gap-3 bg-gray-50 px-4 py-3 rounded-lg border border-gray-200">
          <CarIcon className="w-13 h-13 flex-shrink-0" strokeWidth={2} style={{ stroke: '#22c55e', fill: 'none' }} />
          <div className="text-[16px] font-semibold text-gray-900">{selectedVeicolo.modello}</div>
        </div>}
      </section>

      {/* Pending */}
      {pending.length > 0 && <section className="space-y-4">
        <h3 className="text-[15px] font-semibold tracking-tight">Richieste da accettare</h3>
        <PendingList pending={pending} loadingId={loadingId} onAccetta={handleAccetta} />
      </section>}

      {/* Corse */}
      <section className="space-y-4">
        <h3 className="text-[15px] font-semibold tracking-tight">Corse della giornata</h3>
        <CorseGiornata
          corse={corseFiltrate}
          onToggleCorsa={handleToggleCorsa}
          loadingId={loadingId}
          onSelectCorsa={setCorsaSelezionata} // apertura/chiusura chat gestita qui
        />
      </section>

      {/* CHAT FLOTANTE */}
      {corsaSelezionata && socketRefChat.current && (
        <div className="fixed bottom-4 right-4 w-[360px] h-[450px] bg-white border rounded-2xl shadow-xl flex flex-col overflow-hidden z-50">
          <div className="flex justify-between items-center px-4 py-2 bg-blue-600 text-white">
            <span className="font-semibold">{`Chat corsa #${corsaSelezionata.id}`}</span>
            <button className="text-white text-xl font-bold hover:opacity-80" onClick={() => setCorsaSelezionata(null)}>×</button>
          </div>
          {corsaSelezionata.origine && corsaSelezionata.destinazione && (
            <div className="h-40 border-b">
              <Map origine={corsaSelezionata.origine} destinazione={corsaSelezionata.destinazione} />
            </div>
          )}
          <div className="flex-1 overflow-y-auto">
            <ChatCorsa
              corsaId={corsaSelezionata.id}
              socket={socketRefChat.current}
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