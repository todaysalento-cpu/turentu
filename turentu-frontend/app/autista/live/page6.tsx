'use client';

import { useEffect, useState, useMemo, useRef, useCallback } from 'react';
import { useUser } from '../../../context/UserContext';
import PendingList from '../../../components/PendingList';
import CorseGiornata from '../../../components/CorseGiornata';
import ChatCorsa from '../../../components/ChatCorsa';
import { CarIcon } from 'lucide-react';
import dynamic from 'next/dynamic';
import { io, Socket } from 'socket.io-client';11:49 08/03/2026

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
  const [socketConnected, setSocketConnected] = useState(false);

  const socketRefChat = useRef<Socket | null>(null);

  // ---------- SOCKET CHAT ----------
  useEffect(() => {
    if (!user) return;

    const socket = io(SOCKET_URL, { withCredentials: true });
    socketRefChat.current = socket;

    socket.on('connect', () => {
      console.log('🔌 Socket connesso, ID:', socket.id);
      setSocketConnected(true);
    });

    socket.on('disconnect', () => {
      console.log('⚠️ Socket disconnesso');
      setSocketConnected(false);
    });

    return () => {
      socket.disconnect();
      socketRefChat.current = null;
    };
  }, [user]);

  // ---------- Funzione stabile per Chat ----------
  const onReadMessages = useCallback(() => {
    console.log('📩 Messaggi letti');
  }, []);

  const selectedVeicolo = veicoli.find(v => v.id === selectedVeicoloId);
  const corseFiltrate = useMemo(
    () => corseGiornata.filter(c => c.veicolo_id === selectedVeicoloId),
    [selectedVeicoloId, corseGiornata]
  );

  const veicoliConDisponibilita = useMemo(() =>
    veicoli.map(v => {
      const dispo = disponibilita.find(d => d.veicolo_id === v.id);
      return { ...v, start: dispo?.start ?? null, fine: dispo?.fine ?? null };
    }),
    [veicoli, disponibilita]
  );

  const getDisponibilitaStatus = (veicolo: any) => {
    if (!veicolo?.start || !veicolo?.fine) return 'Non disponibile';
    const now = new Date();
    const start = new Date(veicolo.start);
    const fine = new Date(veicolo.fine);
    return now >= start && now <= fine ? 'Disponibile' : 'Fuori turno';
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
      console.error(err);
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
      if (!res.ok) {
        alert(`Errore ${endpoint} corsa: ${await res.text()}`);
        setLoadingId(null);
        return;
      }
      await res.json();
      setCorseGiornata(prev => prev.map(c => (c.id === corsa.id ? { ...c, stato: nuovaStato } : c)));
      setCorsaSelezionata(nuovaStato === 'in corso' ? { ...corsa, stato: nuovaStato } : null);
    } catch (err: any) {
      console.error(err);
      alert(err.message);
    } finally {
      setLoadingId(null);
    }
  };

  return (
    <div className="w-full max-w-[720px] mx-auto bg-white space-y-8 py-6">
      {/* Selezione veicolo */}
      <section className="space-y-4">
        <div className="flex items-center gap-3">
          <h2 className="text-[14px] font-semibold whitespace-nowrap">Selezione veicolo</h2>
          <select
            value={selectedVeicoloId || ''}
            onChange={e => setSelectedVeicoloId(Number(e.target.value))}
            className="w-[160px] border border-gray-300 rounded-md px-2 py-1 text-[13px] bg-white
                       focus:outline-none focus:ring-1 focus:ring-gray-400 focus:border-gray-400 transition"
          >
            {veicoli.map(v => <option key={v.id} value={v.id}>{v.modello}</option>)}
          </select>
        </div>
        {selectedVeicolo && (
          <div className="flex items-center gap-3 bg-gray-50 px-4 py-3 rounded-lg border border-gray-200">
            <CarIcon
              className="w-13 h-13 flex-shrink-0"
              strokeWidth={2}
              style={{
                stroke: color === 'green' ? '#22c55e' : color === 'yellow' ? '#facc15' : '#9ca3af',
                fill: 'none',
              }}
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
        <CorseGiornata corse={corseFiltrate} onToggleCorsa={handleToggleCorsa} loadingId={loadingId} />
      </section>

{/* Modale Mappa + Chat */}
{corsaSelezionata && socketRefChat.current && (
  <>
    {/* BACKDROP: cliccando fuori chiudi */}
    <div
      className="fixed inset-0 bg-black bg-opacity-50 z-40"
      onClick={() => setCorsaSelezionata(null)}
    />

    {/* MODALE */}
    <div className="fixed inset-0 flex items-center justify-center z-50 pointer-events-none">
      <div className="bg-white rounded-lg p-4 max-w-md w-full space-y-4 relative pointer-events-auto shadow-lg">
        
        {/* Pulsante Chiudi */}
        <button
          className="absolute top-2 right-2 text-gray-500 hover:text-gray-700"
          onClick={() => setCorsaSelezionata(null)}
        >
          Chiudi
        </button>

        {/* Titolo corsa */}
        <h3 className="text-lg font-semibold">{corsaSelezionata.tipo_corsa}</h3>

        {/* MAPPA */}
        <div className="w-full h-64 bg-gray-100">
          <Map
            origine={corsaSelezionata.origine}
            destinazione={corsaSelezionata.destinazione}
          />
        </div>

        {/* CHAT */}
        <div className="h-64 overflow-y-auto border-t border-gray-200 pt-2">
          <ChatCorsa
            corsaId={corsaSelezionata.id}
            socket={socketRefChat.current}
            userId={user.id}
            token={user.token}
            onReadMessages={onReadMessages}
            connected={socketConnected}
          />
        </div>
      </div>
    </div>
  </>
)}
    </div>
  );
}