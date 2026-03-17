'use client';

import { useEffect, useState, useMemo, useRef } from 'react';
import { useUser } from '../../../context/UserContext';
import { io, Socket } from 'socket.io-client';
import { MapPinIcon } from 'lucide-react';

type Veicolo = {
  id: number;
  modello: string;
  immagine?: string;
  disponibile: boolean;
};

type CorsaPending = {
  id: number;
  cliente: string;
  origine: { lat: number; lon: number } | null;
  destinazione: { lat: number; lon: number } | null;
  prezzo: number;
  stato: 'prenotabile' | 'in_corso' | 'accettata';
};

type CorsaGiornata = {
  id: number;
  cliente: string;
  origine: { lat: number; lon: number } | null;
  destinazione: { lat: number; lon: number } | null;
  prezzo: number;
  veicolo_id: number;
  ora: string;
  data: string;
};

const SOCKET_URL = 'http://localhost:3001';

export default function LivePage() {
  const { user } = useUser();

  const [veicoli, setVeicoli] = useState<Veicolo[]>([]);
  const [selectedVeicoloId, setSelectedVeicoloId] = useState<number | null>(null);
  const [pending, setPending] = useState<CorsaPending[]>([]);
  const [corseGiornata, setCorseGiornata] = useState<CorsaGiornata[]>([]);
  const [localitaMap, setLocalitaMap] = useState<Record<string, string>>({});
  const socketRef = useRef<Socket | null>(null);

  const selectedVeicolo =
    veicoli.find(v => v.id === selectedVeicoloId) || veicoli[0];

  const corseFiltrate = useMemo(() => {
    if (!selectedVeicolo) return [];
    return corseGiornata.filter(c => Number(c.veicolo_id) === Number(selectedVeicolo.id));
  }, [selectedVeicolo, corseGiornata]);

  // ------------------- SOCKET -------------------
  useEffect(() => {
    if (!user) return;

    const socket = io(SOCKET_URL, { withCredentials: true });
    socketRef.current = socket;

    socket.emit('join_autista', user.id);

    socket.on('pending_update', (c: CorsaPending) => {
      const cAggiornato = { ...c, prezzo: Number(c.prezzo) || 0 };
      setPending(prev => {
        const exists = prev.find(p => p.id === cAggiornato.id);
        if (!exists) return [cAggiornato, ...prev];
        return prev.map(p => (p.id === cAggiornato.id ? cAggiornato : p));
      });
    });

    return () => socket.disconnect();
  }, [user]);

  // ------------------- FETCH INIZIALE -------------------
  useEffect(() => {
    if (!user) return;

    const fetchData = async () => {
      try {
        // ---------- Corse giornata ----------
        const resGiornata = await fetch(
          `http://localhost:3001/corse/autista/today/${user.id}`,
          { credentials: 'include' }
        );
        const corseDataRaw = await resGiornata.json();
        const corseData: CorsaGiornata[] = Array.isArray(corseDataRaw)
          ? corseDataRaw.map((c: any) => ({
              ...c,
              prezzo: Number(c.prezzo) || 0,
              ora: c.ora || 'N/D',
              data: c.data || 'N/D',
            }))
          : [];
        setCorseGiornata(corseData);

        // ---------- Veicoli ----------
        const resVeicoli = await fetch(`http://localhost:3001/veicolo`, { credentials: 'include' });
        const veicoliData = await resVeicoli.json();
        const veicoliLive: Veicolo[] = Array.isArray(veicoliData)
          ? veicoliData.map((v: any) => ({
              id: v.id,
              modello: v.modello || 'Veicolo sconosciuto',
              immagine:
                v.immagine ||
                'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcSkjvs92_ZNpPDL0dULuabY4ChUQpo4OLPl2A&s',
              disponibile: true,
            }))
          : [];
        setVeicoli(veicoliLive);

        // Seleziona il veicolo automaticamente
        let selectedId = veicoliLive[0]?.id || null;
        if (corseData && corseData.length > 0) {
          const veicoloIdConCorse = corseData[0].veicolo_id;
          const veicoloMatch = veicoliLive.find(v => Number(v.id) === Number(veicoloIdConCorse));
          selectedId = veicoloMatch?.id || selectedId;
        }
        setSelectedVeicoloId(selectedId);

        // ---------- Pending ----------
        const resPending = await fetch(`http://localhost:3001/pending/autista/${user.id}`, { credentials: 'include' });
        const pendingData = await resPending.json();
        const pendingList: CorsaPending[] = Array.isArray(pendingData)
          ? pendingData.map((c: any) => ({ ...c, prezzo: Number(c.prezzo) || 0 }))
          : [];
        setPending(pendingList);

        // ---------- Converti coordinate in località ----------
        const geocodeAll = async () => {
          if (!window.google) return;
          const geocoder = new window.google.maps.Geocoder();
          const newLocalitaMap: Record<string, string> = {};

          const allCoords = [...pendingList, ...corseData];
          for (const item of allCoords) {
            for (const key of ['origine', 'destinazione'] as const) {
              const coord = item[key];
              if (coord) {
                const latlngKey = `${coord.lat},${coord.lon}`;
                if (!newLocalitaMap[latlngKey]) {
                  try {
                    const results = await geocoder.geocode({ location: { lat: coord.lat, lng: coord.lon } });
                    newLocalitaMap[latlngKey] = results[0]?.formatted_address || latlngKey;
                  } catch {
                    newLocalitaMap[latlngKey] = latlngKey;
                  }
                }
              }
            }
          }

          setLocalitaMap(newLocalitaMap);
        };

        geocodeAll();

      } catch (err) {
        console.error('❌ Errore fetch iniziale:', err);
      }
    };

    fetchData();
  }, [user]);

  const handleAccetta = async (id: number) => {
    try {
      await fetch(`http://localhost:3001/pending/${id}/accetta`, {
        method: 'POST',
        credentials: 'include',
      });
      setPending(prev => prev.map(c => (c.id === id ? { ...c, stato: 'accettata' } : c)));
    } catch (err) {
      console.error('Errore accetta richiesta:', err);
    }
  };

  // ---------- Helper per mostrare località ----------
  const getLocalita = (lat: number, lon: number) => {
    return localitaMap[`${lat},${lon}`] || `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  };

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-8">
      {/* Veicolo selezionato */}
      <div className="flex items-center space-x-4 bg-gray-100 p-4 rounded shadow">
        {selectedVeicolo?.immagine && (
          <img src={selectedVeicolo.immagine} alt={selectedVeicolo.modello} className="w-20 h-20 object-cover rounded" />
        )}
        <div>
          <h2 className="text-xl font-semibold">Veicolo selezionato</h2>
          <p className="text-gray-700">{selectedVeicolo?.modello || 'N/D'}</p>
        </div>
      </div>

      {/* Pending */}
      <section>
        <h3 className="text-lg font-semibold mb-2">Pending da accettare</h3>
        {pending.length === 0 ? (
          <p className="text-gray-500">Nessun pending</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {pending.map(c => (
              <div key={c.id} className="p-4 bg-yellow-50 border-l-4 border-yellow-400 rounded shadow hover:bg-yellow-100 transition">
                <p className="font-medium">{c.cliente}</p>
                <p className="flex items-center gap-1"><MapPinIcon className="w-4 h-4 text-gray-600" /> Origine: {c.origine ? getLocalita(c.origine.lat, c.origine.lon) : 'N/D'}</p>
                <p className="flex items-center gap-1"><MapPinIcon className="w-4 h-4 text-red-600" /> Destinazione: {c.destinazione ? getLocalita(c.destinazione.lat, c.destinazione.lon) : 'N/D'}</p>
                <p className="font-semibold mt-1">Prezzo: €{c.prezzo.toFixed(2)}</p>
                <button onClick={() => handleAccetta(c.id)} className="mt-2 px-3 py-1 bg-blue-500 text-white rounded hover:bg-blue-600 transition">Accetta</button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Corse giornata */}
      <section>
        <h3 className="text-lg font-semibold mb-2">Corse della giornata</h3>
        {corseFiltrate.length === 0 ? (
          <p className="text-gray-500">Nessuna corsa per questo veicolo oggi</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {corseFiltrate.map(c => (
              <div key={c.id} className="p-4 bg-white border rounded shadow hover:shadow-md transition">
                <p className="text-sm text-gray-500">{c.data} - {c.ora}</p>
                <p className="flex items-center gap-1"><MapPinIcon className="w-4 h-4 text-gray-600" /> Origine: {c.origine ? getLocalita(c.origine.lat, c.origine.lon) : 'N/D'}</p>
                <p className="flex items-center gap-1"><MapPinIcon className="w-4 h-4 text-red-600" /> Destinazione: {c.destinazione ? getLocalita(c.destinazione.lat, c.destinazione.lon) : 'N/D'}</p>
                <p className="font-semibold mt-1">Prezzo: €{c.prezzo.toFixed(2)}</p>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
