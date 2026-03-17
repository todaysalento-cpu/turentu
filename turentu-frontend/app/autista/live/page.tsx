'use client';

import { useEffect, useState, useMemo } from 'react';
import { useUser } from '../../../context/UserContext';
import { useSocket } from '../../../context/SocketProvider';
import PendingList from '../../../components/PendingList';
import CorseGiornata from '../../../components/CorseGiornata';
import { CarIcon } from 'lucide-react';
import dynamic from 'next/dynamic';

const Map = dynamic(() => import('../../../components/Map'), { ssr: false });

export default function LivePage() {
  const { user } = useUser();
  const { socket } = useSocket();

  const [veicoli, setVeicoli] = useState<any[]>([]);
  const [selectedVeicoloId, setSelectedVeicoloId] = useState<number | null>(null);
  const [pending, setPending] = useState<any[]>([]);
  const [corseGiornata, setCorseGiornata] = useState<any[]>([]);
  const [loadingId, setLoadingId] = useState<number | null>(null);
  const [disponibilita, setDisponibilita] = useState<any[]>([]);
  const [corsaSelezionata, setCorsaSelezionata] = useState<any | null>(null);
  const [unreadCounts, setUnreadCounts] = useState<Record<number, number>>({});

  // ---------------- FETCH INIZIALE ----------------
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
        if (dataV?.length) setSelectedVeicoloId(dataV[0].id);
      } catch (err) {
        console.error(err);
      }
    })();
  }, [user]);

  // ---------------- FETCH PENDING ----------------
  useEffect(() => {
    if (!user || !selectedVeicoloId) return;

    (async () => {
      try {
        const res = await fetch(
          `http://localhost:3001/pending/autista/${selectedVeicoloId}`,
          { credentials: 'include' }
        );
        const data = await res.json();
        setPending(Array.isArray(data?.pendings) ? data.pendings : []);
      } catch (err) {
        console.error(err);
      }
    })();
  }, [user, selectedVeicoloId]);

  // ---------------- ACCETTA CORSA ----------------
  const handleAccetta = async (id: number) => {
    if (loadingId) return;
    try {
      setLoadingId(id);
      const res = await fetch(`http://localhost:3001/pending/${id}/accetta`, {
        method: 'POST',
        credentials: 'include'
      });
      const data = await res.json();
      setPending(prev => prev.filter(p => p.id !== id));
      if (data.corsa) setCorseGiornata(prev => [...prev, data.corsa]);
    } catch (err: any) {
      alert(err.message);
    } finally {
      setLoadingId(null);
    }
  };

  // ---------------- START / END CORSA ----------------
  const handleToggleCorsa = async (corsa: any) => {
    if (loadingId) return;
    try {
      setLoadingId(corsa.id);
      const endpoint = corsa.stato === 'in_corso' ? 'end' : 'start';
      const res = await fetch(`http://localhost:3001/corse/${corsa.id}/${endpoint}`, {
        method: 'POST',
        credentials: 'include'
      });
      const data = await res.json();
      const corsaAggiornata = data.corsa || data.nuovaCorsa || corsa;
      setCorseGiornata(prev =>
        prev.map(c => c.id === corsaAggiornata.id ? corsaAggiornata : c)
      );
      setCorsaSelezionata({
        ...corsaAggiornata,
        origine: corsaAggiornata.origine_address || corsaAggiornata.origine,
        destinazione: corsaAggiornata.destinazione_address || corsaAggiornata.destinazione
      });
    } catch (err: any) {
      alert(err.message);
    } finally {
      setLoadingId(null);
    }
  };

  // ---------------- FILTRO CORSE ----------------
  const selectedVeicolo = veicoli.find(v => v.id === selectedVeicoloId);
  const corseFiltrate = useMemo(() =>
    corseGiornata.filter(c => c.veicolo_id === selectedVeicoloId),
    [corseGiornata, selectedVeicoloId]
  );

  // ---------------- UI ----------------
  return (
    <div className="w-full max-w-[720px] mx-auto bg-white space-y-8 py-6">

      {/* Selezione Veicolo */}
      <section className="space-y-4">
        <div className="flex items-center gap-3">
          <h2 className="text-[14px] font-semibold">Selezione veicolo</h2>
          <select
            value={selectedVeicoloId || ''}
            onChange={e => setSelectedVeicoloId(Number(e.target.value))}
            className="border rounded px-2 py-1"
          >
            {veicoli.map(v => <option key={v.id} value={v.id}>{v.modello}</option>)}
          </select>
        </div>

        {selectedVeicolo && (
          <div className="flex items-center gap-3 bg-gray-50 px-4 py-3 rounded-lg border">
            <CarIcon className="w-12 h-12" style={{ stroke: '#22c55e' }} />
            <div className="font-semibold">{selectedVeicolo.modello}</div>
          </div>
        )}
      </section>

      {/* Pending */}
      {pending.length > 0 && <PendingList pending={pending} loadingId={loadingId} onAccetta={handleAccetta} />}

      {/* Corse Giornata */}
      <CorseGiornata
        corse={corseFiltrate}
        onToggleCorsa={handleToggleCorsa}
        loadingId={loadingId}
        unreadCounts={unreadCounts}
        onSelectCorsa={(corsa) => setCorsaSelezionata({
          ...corsa,
          origine: corsa.origine_address || corsa.origine,
          destinazione: corsa.destinazione_address || corsa.destinazione
        })}
      />

      {/* Map della corsa selezionata */}
      {corsaSelezionata && (
        <div className="h-40 border-b">
          <Map
            origine={corsaSelezionata.origine}
            destinazione={corsaSelezionata.destinazione}
          />
        </div>
      )}

    </div>
  );
}