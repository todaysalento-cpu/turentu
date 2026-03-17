'use client';

import { useEffect, useState, useRef } from 'react';
import { FaCar } from 'react-icons/fa';
import { useUser } from '../../../context/UserContext';
import { GoogleMap, Marker, useLoadScript } from '@react-google-maps/api';
import { io, Socket } from 'socket.io-client';

type Turno = {
  id: number;
  start: string;
  fine: string;
  veicolo: string;
  disponibile: boolean;
  coord?: { lat: number; lng: number };
};

type CorsaPending = {
  id: number;
  cliente: string;
  origine: string | null;
  destinazione: string | null;
  prezzo: number;
  stato: 'pending' | 'accettata';
};

const mapContainerStyle = { width: '100%', height: '200px' };
const SOCKET_URL = 'http://localhost:3001';

export default function LivePage() {
  const { user } = useUser();
  const [turni, setTurni] = useState<Turno[]>([]);
  const [pending, setPending] = useState<CorsaPending[]>([]);
  const [seenPendingIds, setSeenPendingIds] = useState<number[]>([]);
  const { isLoaded } = useLoadScript({
    googleMapsApiKey: process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY || '',
  });
  const [pageTitle, setPageTitle] = useState('Benvenuto');
  const socketRef = useRef<Socket | null>(null);

  const parseDate = (s?: string) => (s ? new Date(s) : null);

  // -------------------- SOCKET.IO --------------------
  useEffect(() => {
    if (!user) return;

    const socket = io(SOCKET_URL, { withCredentials: true });
    socketRef.current = socket;

    socket.emit('join_room', `autista_${user.id}`);

    socket.on('pending_update', (c: CorsaPending) => {
      setPending((prev) => {
        const exists = prev.find((p) => p.id === c.id);
        if (exists) return prev.map((p) => (p.id === c.id ? c : p));
        return [...prev, c];
      });

      if (!seenPendingIds.includes(c.id)) {
        setSeenPendingIds((prev) => [...prev, c.id]);
      }

      new Audio('/sounds/ding.mp3').play().catch(() => {});
    });

    return () => {
      socket.disconnect();
    };
  }, [user]);

  // -------------------- FETCH INIZIALE --------------------
  useEffect(() => {
    if (!user) return;

    const fetchData = async () => {
      try {
        // Fetch turni
        const resTurni = await fetch(`http://localhost:3001/disponibilita/?today=true`, {
          credentials: 'include',
        });
        const dataTurni = await resTurni.json();

        const now = new Date();
        const turniLive: Turno[] = dataTurni.map((t: any) => ({
          id: t.id,
          veicolo: t.modello || 'Veicolo sconosciuto',
          start: t.start || '',
          fine: t.fine || '',
          disponibile: now >= new Date(t.start) && now <= new Date(t.fine),
          coord:
            t.coord?.lat && t.coord?.lon ? { lat: t.coord.lat, lng: t.coord.lon } : undefined,
        }));
        setTurni(turniLive);

        // Fetch pending
        const resPending = await fetch(`http://localhost:3001/pending/autista/${user.id}`, {
          credentials: 'include',
        });
        const dataPending: CorsaPending[] = await resPending.json();
        dataPending.forEach((c) => (c.prezzo = Number(c.prezzo) || 0));
        setPending(dataPending);
        setSeenPendingIds(dataPending.map((c) => c.id));
      } catch (err) {
        console.error('Errore fetch iniziale:', err);
      }
    };

    fetchData();
  }, [user]);

  // -------------------- TITOLI DINAMICI --------------------
  useEffect(() => {
    const now = new Date();

    if (turni.length === 0) return setPageTitle('Benvenuto');

    const turnoInCorso = turni.find((t) => {
      const startDate = parseDate(t.start);
      const fineDate = parseDate(t.fine);
      return startDate && fineDate ? now >= startDate && now <= fineDate : false;
    });

    if (turnoInCorso) {
      setPageTitle(`Turno in corso - ${turnoInCorso.veicolo}`);
    } else {
      const prossimoTurno = turni.find((t) => parseDate(t.start)! > now);
      setPageTitle(
        prossimoTurno
          ? `Prossimo turno alle ${parseDate(prossimoTurno.start)?.toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}`
          : 'Benvenuto'
      );
    }
  }, [turni]);

  // -------------------- ACCETTA PENDING --------------------
  const handleAccetta = async (id: number) => {
    try {
      await fetch(`http://localhost:3001/pending/${id}/accetta`, {
        method: 'POST',
        credentials: 'include',
      });

      setPending((prev) =>
        prev.map((c) => (c.id === id ? { ...c, stato: 'accettata' } : c))
      );
    } catch (err) {
      console.error('Errore accetta richiesta:', err);
    }
  };

  // -------------------- RENDER --------------------
  return (
    <div className="p-4 space-y-6 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-2">{pageTitle}</h1>

      {/* Turni */}
      <div className="space-y-4">
        {turni.length === 0 && <p className="text-gray-500">Nessun turno programmato oggi.</p>}

        {turni.map((t, i) => {
          const startDate = parseDate(t.start);
          const fineDate = parseDate(t.fine);

          return (
            <div key={i} className="bg-white shadow rounded p-4 space-y-2">
              <div className="flex justify-between items-center">
                <h2 className="font-semibold text-lg flex items-center gap-2">
                  <FaCar /> {t.veicolo}
                </h2>

                <span
                  className={`px-2 py-1 rounded text-white text-sm ${
                    t.disponibile ? 'bg-green-600' : 'bg-red-600'
                  }`}
                >
                  {t.disponibile ? 'Disponibile' : 'Non disponibile'}
                </span>
              </div>

              <p className="text-gray-600">
                {startDate ? startDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'N/D'}{' '}
                - {fineDate ? fineDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '-'}
              </p>

              {t.coord && isLoaded && (
                <GoogleMap mapContainerStyle={mapContainerStyle} center={t.coord} zoom={14}>
                  <Marker
                    position={t.coord}
                    label={{ text: t.veicolo, color: 'white', fontWeight: 'bold' }}
                  />
                </GoogleMap>
              )}
            </div>
          );
        })}
      </div>

      {/* Pending */}
      <div className="bg-white shadow rounded p-4 space-y-4">
        <h2 className="font-semibold flex items-center gap-2">
          <FaCar /> Richieste pendenti
        </h2>

        {pending.length === 0 && <p className="text-gray-500">Nessuna richiesta pendente.</p>}

        {pending.map((c) => {
          const isNew = !seenPendingIds.includes(c.id) && c.stato === 'pending';

          return (
            <div
              key={c.id}
              className={`border p-3 rounded flex justify-between items-center shadow-sm ${
                c.stato === 'accettata' ? 'bg-green-50' : ''
              }`}
            >
              <div className="flex flex-col">
                <p className="flex items-center gap-2">
                  <span className="font-medium">{c.cliente}</span>
                  {isNew && (
                    <span className="animate-pulse bg-red-500 text-white text-xs px-2 py-0.5 rounded-full">
                      NUOVA
                    </span>
                  )}
                </p>
                <p>
                  {c.origine || 'N/D'} → {c.destinazione || 'N/D'}
                </p>
                <p className="text-gray-600">Prezzo stimato: € {c.prezzo.toFixed(2)}</p>
              </div>

              {c.stato === 'pending' ? (
                <button
                  onClick={() => handleAccetta(c.id)}
                  className="bg-green-600 text-white px-4 py-2 rounded hover:bg-green-700"
                >
                  Accetta
                </button>
              ) : (
                <span className="text-green-700 font-semibold">Accettata</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
