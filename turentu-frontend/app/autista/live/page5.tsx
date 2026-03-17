'use client';

import { useEffect, useState, useMemo, useRef } from 'react';
import { useUser } from '../../../context/UserContext';
import { io } from 'socket.io-client';
import PendingList from '../../../components/PendingList';
import CorseGiornata from '../../../components/CorseGiornata';
import { CarIcon } from 'lucide-react';
import dynamic from 'next/dynamic';

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

  const socketRef = useRef<any>(null);
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

  // ---------- SOCKET ----------
  useEffect(() => {
    if (!user) return;
    const socket = io(SOCKET_URL, { withCredentials: true });
    socketRef.current = socket;
    socket.emit('join_autista', user.id);

    const handlePendingUpdate = (c: any) => {
      setPending(prev => {
        const exists = prev.find(p => p.id === c.id);
        return exists ? prev.map(p => (p.id === c.id ? { ...p, ...c } : p)) : [c, ...prev];
      });
    };

    const handleCorsaCreated = (nuovaCorsa: any) => {
      if (!nuovaCorsa?.veicolo_id) return;
      setCorseGiornata(prev => {
        const exists = prev.find(c => c.id === nuovaCorsa.id);
        return exists ? prev.map(c => (c.id === nuovaCorsa.id ? { ...c, ...nuovaCorsa } : c)) : [...prev, nuovaCorsa];
      });
      setLoadingId(null);
    };

    socket.on('pending_update', handlePendingUpdate);
    socket.on('corsa_created', handleCorsaCreated);

    return () => {
      socket.off('pending_update', handlePendingUpdate);
      socket.off('corsa_created', handleCorsaCreated);
      socket.disconnect();
    };
  }, [user]);

  // ---------- FETCH INIZIALE ----------
  useEffect(() => {
    if (!user) return;
    const fetchData = async () => {
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
        console.error('Errore fetch iniziale:', err);
      }
    };
    fetchData();
  }, [user]);

  // ---------- FETCH PENDING ----------
  useEffect(() => {
    if (!user || !selectedVeicoloId) return;
    const fetchPending = async () => {
      try {
        const res = await fetch(`http://localhost:3001/pending/autista/${selectedVeicoloId}`, { credentials: 'include' });
        if (!res.ok) {
          const text = await res.text();
          console.error('Errore fetch pending:', text);
          return;
        }
        const data = await res.json();
        setPending(Array.isArray(data?.pendings) ? data.pendings : []);
      } catch (err) {
        console.error('Errore fetch pending:', err);
      }
    };
    fetchPending();
  }, [user, selectedVeicoloId]);

  // ---------- FUNZIONI ----------
  const handleAccetta = async (id: number) => {
    if (loadingId) return;
    try {
      setLoadingId(id);
      const res = await fetch(`http://localhost:3001/pending/${id}/accetta`, { method: 'POST', credentials: 'include' });
      if (!res.ok) {
        const text = await res.text();
        alert(`Errore accettazione pending: ${text}`);
        return;
      }
      const data = await res.json();
      setPending(prev =>
        prev.map(p => (p.id === id ? { ...p, stato: 'accettata', corsa_id: data?.corsa_id || p.corsa_id } : p))
      );
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
        const text = await res.text();
        alert(`Errore ${endpoint} corsa: ${text}`);
        setLoadingId(null);
        return;
      }
      const data = await res.json();
      setCorseGiornata(prev => prev.map(c => (c.id === corsa.id ? { ...c, stato: nuovaStato } : c)));

      if (nuovaStato === 'in corso') {
        setCorsaSelezionata({ ...corsa, stato: nuovaStato });
      } else {
        setCorsaSelezionata(null);
        try {
          const captureRes = await fetch(`http://localhost:3001/booking/capture/${corsa.id}`, { method: 'POST', credentials: 'include' });
          if (!captureRes.ok) {
            const text = await captureRes.text();
            console.warn('Errore capture pagamento:', text);
          } else {
            const captureData = await captureRes.json();
            console.log('Pagamento catturato:', captureData);
          }
        } catch (err) {
          console.error('Errore capture pagamento:', err);
        }
      }
    } catch (err: any) {
      console.error(err);
      alert(err.message);
    } finally {
      setLoadingId(null);
    }
  };

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

  // ---------- RENDER ----------
  return (
    <div className="w-full max-w-[720px] mx-auto bg-white space-y-8 py-6">
      {/* SELEZIONE VEICOLO */}
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

      {/* PENDING - Renderizza solo se ci sono richieste */}
      {pending.length > 0 && (
        <section className="space-y-4">
          <h3 className="text-[15px] font-semibold tracking-tight">Richieste da accettare</h3>
          <PendingList pending={pending} loadingId={loadingId} onAccetta={handleAccetta} />
        </section>
      )}

      {/* CORSE GIORNATA */}
      <section className="space-y-4">
        <h3 className="text-[15px] font-semibold tracking-tight">Corse della giornata</h3>
        <CorseGiornata corse={corseFiltrate} onToggleCorsa={handleToggleCorsa} loadingId={loadingId} />
      </section>

      {/* CARD MAPPA */}
      {corsaSelezionata && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-4 max-w-md w-full space-y-4 relative">
            <button className="absolute top-2 right-2 text-gray-500 hover:text-gray-700" onClick={() => setCorsaSelezionata(null)}>Chiudi</button>
            <h3 className="text-lg font-semibold">Corsa in corso: {corsaSelezionata.tipo_corsa}</h3>
            <div className="w-full h-64">
              <Map origine={corsaSelezionata.origine} destinazione={corsaSelezionata.destinazione} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}