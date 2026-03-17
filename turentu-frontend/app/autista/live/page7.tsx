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

  // ---------- STATE ----------
  const [veicoli, setVeicoli] = useState<any[]>([]);
  const [selectedVeicoloId, setSelectedVeicoloId] = useState<number | null>(null);
  const [pending, setPending] = useState<any[]>([]);
  const [corseGiornata, setCorseGiornata] = useState<any[]>([]);
  const [loadingId, setLoadingId] = useState<number | null>(null);
  const [disponibilita, setDisponibilita] = useState<any[]>([]);
  const [corsaSelezionata, setCorsaSelezionata] = useState<any | null>(null);
  const [socketConnected, setSocketConnected] = useState(false);
  const [unreadCounts, setUnreadCounts] = useState<Record<number, number>>({});

  const socketRefChat = useRef<Socket | null>(null);

  // ---------- SOCKET CHAT ----------
  useEffect(() => {
    if (!user || socketRefChat.current) return;

    const socket = io(SOCKET_URL, {
      withCredentials: true,
      auth: { token: user.token },
    });

    socketRefChat.current = socket;

    const handleConnect = () => setSocketConnected(true);
    const handleDisconnect = () => setSocketConnected(false);
    const handleUnread = ({ corsa_id, count }: { corsa_id: number; count: number }) => {
      setUnreadCounts(prev => ({ ...prev, [corsa_id]: count }));
    };

    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);
    socket.on('unread_count', handleUnread);

    return () => {
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
      socket.off('unread_count', handleUnread);
      socket.disconnect();
      socketRefChat.current = null;
    };
  }, [user]);

  // ---------- ON READ MESSAGES ----------
  const onReadMessages = useCallback((corsaId: number) => {
    // Azzeriamo il contatore unread
    setUnreadCounts(prev => ({ ...prev, [corsaId]: 0 }));

    // Chiamata all'endpoint corretto
    fetch(`http://localhost:3001/chat/${corsaId}/read`, {
      method: 'POST',
      credentials: 'include'
    }).catch(err => console.error('Errore marking messages as read:', err));
  }, []);

  // ---------- Calcoli veicoli e corse ----------
  const selectedVeicolo = veicoli.find(v => v.id === selectedVeicoloId);
  const corseFiltrate = useMemo(
    () => corseGiornata.filter(c => c.veicolo_id === selectedVeicoloId),
    [selectedVeicoloId, corseGiornata]
  );

  const veicoliConDisponibilita = useMemo(
    () =>
      veicoli.map(v => {
        const dispo = disponibilita.find(d => d.veicolo_id === v.id);
        return { ...v, start: dispo?.start ?? null, fine: dispo?.fine ?? null };
      }),
    [veicoli, disponibilita]
  );

  const getDisponibilitaStatus = (veicolo: any) => {
    if (!veicolo?.start || !veicolo?.fine) return 'Non disponibile';
    const now = new Date();
    return now >= new Date(veicolo.start) && now <= new Date(veicolo.fine) ? 'Disponibile' : 'Fuori turno';
  };

  const getColorClass = (status: string) => {
    switch (status) {
      case 'Disponibile': return 'green';
      case 'Fuori turno': return 'yellow';
      default: return 'gray';
    }
  };

  const veicoloStatus = selectedVeicolo
    ? getDisponibilitaStatus(veicoliConDisponibilita.find(v => v.id === selectedVeicoloId))
    : null;

  const color = getColorClass(veicoloStatus || '');

  // ---------- Fetch iniziali ----------
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

        if (dataV.length > 0) setSelectedVeicoloId(dataV[0].id);
      } catch (err) {
        console.error(err);
      }
    })();
  }, [user]);

  // ---------- Fetch Pending ----------
  useEffect(() => {
    if (!user || !selectedVeicoloId) return;

    (async () => {
      try {
        const res = await fetch(`http://localhost:3001/pending/autista/${selectedVeicoloId}`, { credentials: 'include' });
        const data = await res.json();
        setPending(Array.isArray(data?.pendings) ? data.pendings : []);
      } catch (err) {
        console.error(err);
      }
    })();
  }, [user, selectedVeicoloId]);

  // ---------- Gestione corsa ----------
  const handleAccetta = async (id: number) => {
    if (loadingId) return;
    try {
      setLoadingId(id);
      const res = await fetch(`http://localhost:3001/pending/${id}/accetta`, { method: 'POST', credentials: 'include' });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setPending(prev => prev.filter(p => p.id !== id));
      if (data.corsa) setCorseGiornata(prev => [...prev, data.corsa]);
    } catch (err: any) {
      alert(err.message);
    } finally {
      setLoadingId(null);
    }
  };

  const handleToggleCorsa = async (corsa: any) => {
    if (loadingId) return;
    try {
      setLoadingId(corsa.id);
      const nuovaStato = corsa.stato === 'in corso' ? 'terminata' : 'in corso';
      const endpoint = corsa.stato === 'in corso' ? 'end' : 'start';
      const res = await fetch(`http://localhost:3001/corse/${corsa.id}/${endpoint}`, { method: 'POST', credentials: 'include' });
      if (!res.ok) { alert(`Errore ${endpoint} corsa: ${await res.text()}`); setLoadingId(null); return; }
      await res.json();
      setCorseGiornata(prev => prev.map(c => (c.id === corsa.id ? { ...c, stato: nuovaStato } : c)));
      setCorsaSelezionata(nuovaStato === 'in corso' ? { ...corsa, stato: nuovaStato } : null);
    } catch (err: any) {
      alert(err.message);
    } finally {
      setLoadingId(null);
    }
  };

  // ---------- Render ----------
  return (
    <div className="w-full max-w-[720px] mx-auto bg-white space-y-8 py-6">

      {/* Selezione veicolo */}
      <section className="space-y-4">
        <div className="flex items-center gap-3">
          <h2 className="text-[14px] font-semibold whitespace-nowrap">Selezione veicolo</h2>
          <select
            value={selectedVeicoloId || ''}
            onChange={e => setSelectedVeicoloId(Number(e.target.value))}
            className="w-[160px] border border-gray-300 rounded-md px-2 py-1 text-[13px] bg-white focus:outline-none focus:ring-1 focus:ring-gray-400 focus:border-gray-400 transition"
          >
            {veicoli.map(v => <option key={v.id} value={v.id}>{v.modello}</option>)}
          </select>
        </div>

        {selectedVeicolo && (
          <div className="flex items-center gap-3 bg-gray-50 px-4 py-3 rounded-lg border border-gray-200">
            <CarIcon
              className="w-13 h-13 flex-shrink-0"
              strokeWidth={2}
              style={{ stroke: color === 'green' ? '#22c55e' : color === 'yellow' ? '#facc15' : '#9ca3af', fill: 'none' }}
            />
            <div className="text-[16px] font-semibold text-gray-900">{selectedVeicolo.modello}</div>
          </div>
        )}
      </section>

      {/* Pending */}
      {pending.length > 0 && (
        <section className="space-y-4">
          <h3 className="text-[15px] font-semibold tracking-tight">Richieste da accettare</h3>
          <PendingList pending={pending} loadingId={loadingId} onAccetta={handleAccetta} />
        </section>
      )}

      {/* Corse */}
      <section className="space-y-4">
        <h3 className="text-[15px] font-semibold tracking-tight">Corse della giornata</h3>
        <CorseGiornata corse={corseFiltrate} onToggleCorsa={handleToggleCorsa} loadingId={loadingId} unreadCounts={unreadCounts} />
      </section>

      {/* Modale corsa */}
      {corsaSelezionata && socketRefChat.current && (
        <>
          <div className="fixed inset-0 bg-black bg-opacity-50 z-40" onClick={() => setCorsaSelezionata(null)} />
          <div className="fixed inset-0 flex items-end justify-center z-50 px-2 sm:px-4">
            <div className="bg-white rounded-2xl shadow-xl w-full max-w-md sm:max-w-lg p-6 space-y-4 relative overflow-hidden">
              
              <button className="absolute top-3 right-3 text-gray-500 hover:text-gray-700" onClick={() => setCorsaSelezionata(null)}>✕</button>
              <h3 className="text-xl font-semibold">{corsaSelezionata.tipo_corsa}</h3>

              {/* Info passeggero */}
              <div className="flex items-center gap-3 bg-gray-50 p-3 rounded-lg border border-gray-200">
                <div className="w-12 h-12 bg-gray-300 rounded-full flex items-center justify-center">
                  {corsaSelezionata.passeggero?.nome?.[0]}
                </div>
                <div>
                  <div className="text-gray-900 font-semibold">{corsaSelezionata.passeggero?.nome}</div>
                  <div className="text-gray-500 text-sm">{corsaSelezionata.passeggero?.telefono}</div>
                </div>
                {unreadCounts[corsaSelezionata.id] > 0 && (
                  <div className="ml-auto bg-red-500 text-white text-xs font-semibold px-2 py-0.5 rounded-full">
                    {unreadCounts[corsaSelezionata.id]}
                  </div>
                )}
              </div>

              {/* Percorso */}
              <div className="space-y-1">
                <div className="flex items-center gap-2 text-gray-700">
                  <div className="w-3 h-3 bg-green-500 rounded-full"></div>
                  <div>{corsaSelezionata.origine?.indirizzo}</div>
                </div>
                <div className="flex items-center gap-2 text-gray-700">
                  <div className="w-3 h-3 bg-red-500 rounded-full"></div>
                  <div>{corsaSelezionata.destinazione?.indirizzo}</div>
                </div>
              </div>

              {/* Mappa */}
              <div className="w-full h-40 bg-gray-100 rounded-lg">
                <Map origine={corsaSelezionata.origine} destinazione={corsaSelezionata.destinazione} />
              </div>

              {/* Pulsanti azione */}
              <div className="flex flex-col sm:flex-row gap-3">
                <button className="flex-1 bg-blue-600 text-white font-semibold py-2 rounded-lg hover:bg-blue-700 transition"
                  onClick={async () => { await fetch(`http://localhost:3001/corse/${corsaSelezionata.id}/sto_arrivando`, { method: 'POST', credentials: 'include' }); alert('Notifica inviata al passeggero!'); }}
                >
                  🚗 Sto arrivando
                </button>

                <button className="flex-1 bg-green-600 text-white font-semibold py-2 rounded-lg hover:bg-green-700 transition"
                  onClick={async () => { await fetch(`http://localhost:3001/corse/${corsaSelezionata.id}/sono_frente`, { method: 'POST', credentials: 'include' }); alert('Pasggero informato!'); }}
                >
                  🏁 Sono davanti
                </button>

                <button className="flex-1 bg-red-600 text-white font-semibold py-2 rounded-lg hover:bg-red-700 transition"
                  onClick={() => handleToggleCorsa(corsaSelezionata)}
                >
                  ⏹️ Termina corsa
                </button>
              </div>

              {/* Chat */}
              <div className="h-40 overflow-y-auto border-t border-gray-200 pt-2">
                <ChatCorsa
                  corsaId={corsaSelezionata.id}
                  socket={socketRefChat.current}
                  userRole={user.role === 'autista' ? 'Autista' : 'Cliente'}
                  onReadMessages={() => onReadMessages(corsaSelezionata.id)}
                />
              </div>

            </div>
          </div>
        </>
      )}
    </div>
  );
}