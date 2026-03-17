'use client';

import { useEffect, useState, useRef } from 'react';
import { FaCar } from 'react-icons/fa';
import { useUser } from '../../../context/UserContext';
import { GoogleMap, Marker } from '@react-google-maps/api';
import { io, Socket } from 'socket.io-client';

type Veicolo = {
  id: number;
  modello: string;
  immagine?: string;
  coord?: { lat: number; lng: number };
  disponibile: boolean;
};

type CorsaPending = {
  id: number;
  cliente: string;
  origine: { lat: number; lon: number } | null;
  destinazione: { lat: number; lon: number } | null;
  origineStr?: string;
  destinazioneStr?: string;
  prezzo: number;
  stato: 'pending' | 'accettata';
  passeggeri?: number;
  ora?: string;
};

type CorsaGiornata = {
  id: number;
  cliente: string;
  origine: { lat: number; lon: number } | null;
  destinazione: { lat: number; lon: number } | null;
  prezzo: number;
  veicolo_id: number;
  ora: string;
};

const mapContainerStyle = { width: '100%', height: '200px' };
const SOCKET_URL = 'http://localhost:3001';

const fetchAddress = async (lat: number, lng: number) => {
  try {
    const res = await fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY}`
    );
    const data = await res.json();
    if (data.status === 'OK' && data.results.length > 0) return data.results[0].formatted_address;
    return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  } catch {
    return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  }
};

export default function LivePage() {
  const { user } = useUser();
  const [veicoli, setVeicoli] = useState<Veicolo[]>([]);
  const [selectedVeicoloId, setSelectedVeicoloId] = useState<number | null>(null);
  const [pending, setPending] = useState<CorsaPending[]>([]);
  const [corseGiornata, setCorseGiornata] = useState<CorsaGiornata[]>([]);

  const socketRef = useRef<Socket | null>(null);
  const seenPendingRef = useRef<number[]>([]);

  const selectedVeicolo = veicoli.find((v) => v.id === selectedVeicoloId) || veicoli[0];

  useEffect(() => {
    if (!user || user.guest) return;

    const socket = io(SOCKET_URL, { withCredentials: true });
    socketRef.current = socket;
    socket.emit('join_autista', user.id);

    socket.on('pending_update', async (c: CorsaPending) => {
      const cAggiornato = { ...c, prezzo: Number(c.prezzo) || 0 };
      setPending((prev) => {
        const exists = prev.find((p) => p.id === cAggiornato.id);
        if (!exists) return [cAggiornato, ...prev];
        return prev.map((p) => (p.id === cAggiornato.id ? cAggiornato : p));
      });
    });

    return () => socket.disconnect();
  }, [user]);

  useEffect(() => {
    if (!user || user.guest) return;

    const parseCoord = (coord: any) => {
      if (!coord) return null;
      if (typeof coord === 'object' && 'lat' in coord && 'lon' in coord) return coord;
      if (typeof coord === 'string') {
        try {
          const parsed = JSON.parse(coord);
          if (parsed && 'lat' in parsed && 'lon' in parsed) return parsed;
        } catch {}
      }
      return null;
    };

    const fetchData = async () => {
      try {
        const now = new Date();

        // ------------------- VEICOLI -------------------
        const resVeicoli = await fetch(`http://localhost:3001/disponibilita/?today=true&driver_id=${user.id}`, {
          credentials: 'include',
        });
        const dataVeicoliRaw = await resVeicoli.json();
        const veicoliArray = Array.isArray(dataVeicoliRaw) ? dataVeicoliRaw : [];

        const veicoliLive: Veicolo[] = veicoliArray.map((v: any) => ({
          id: v.id,
          modello: v.modello || 'Veicolo sconosciuto',
          immagine:
            v.immagine ||
            'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcSkjvs92_ZNpPDL0dULuabY4ChUQpo4OLPl2A&s',
          coord: v.coord?.lat && v.coord?.lon ? { lat: v.coord.lat, lng: v.coord.lng || v.coord.lon } : undefined,
          disponibile: now >= new Date(v.start) && now <= new Date(v.fine),
        }));
        setVeicoli(veicoliLive);
        setSelectedVeicoloId(veicoliLive[0]?.id || null);

        // ------------------- PENDING -------------------
        const resPending = await fetch(`http://localhost:3001/pending/autista/${user.id}`, { credentials: 'include' });
        const dataPendingRaw = await resPending.json();
        const dataPending: CorsaPending[] = Array.isArray(dataPendingRaw) ? dataPendingRaw : [];

        const dataPendingConIndirizzo = await Promise.all(
          dataPending.map(async (c) => {
            const origineCoord = parseCoord(c.origine);
            const destCoord = parseCoord(c.destinazione);
            const origineStr = origineCoord ? await fetchAddress(origineCoord.lat, origineCoord.lon) : undefined;
            const destinazioneStr = destCoord ? await fetchAddress(destCoord.lat, destCoord.lon) : undefined;
            return { ...c, origine: origineCoord, destinazione: destCoord, origineStr, destinazioneStr, prezzo: Number(c.prezzo) || 0 };
          })
        );

        setPending(dataPendingConIndirizzo);
        seenPendingRef.current = dataPendingConIndirizzo.map((c) => c.id);

        // ------------------- CORSE GIORNATA -------------------
        const resGiornata = await fetch(`http://localhost:3001/corse/autista/today/${user.id}`, {
          credentials: 'include',
        });
        const corseDataRaw = await resGiornata.json();
        const corseData: CorsaGiornata[] = Array.isArray(corseDataRaw) ? corseDataRaw : [];
        corseData.forEach((c) => (c.prezzo = Number(c.prezzo) || 0));
        setCorseGiornata(corseData);
      } catch (err: any) {
        console.error('Errore fetch iniziale:', err);
      }
    };

    fetchData();
  }, [user]);

  const handleAccetta = async (id: number) => {
    try {
      await fetch(`http://localhost:3001/pending/${id}/accetta`, { method: 'POST', credentials: 'include' });
      setPending((prev) => prev.map((c) => (c.id === id ? { ...c, stato: 'accettata' } : c)));
    } catch (err) {
      console.error('Errore accetta richiesta:', err);
    }
  };

  return (
    <div className="p-4 space-y-6 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-2">Live Dashboard Autista</h1>

      {/* Seleziona veicolo */}
      {veicoli.length > 0 && (
        <div className="mb-4">
          <label className="block font-medium mb-1">Seleziona veicolo:</label>
          <select
            className="border rounded px-3 py-2 w-full"
            value={selectedVeicoloId || undefined}
            onChange={(e) => setSelectedVeicoloId(Number(e.target.value))}
          >
            {veicoli.map((v) => (
              <option key={v.id} value={v.id}>
                {v.modello} {v.disponibile ? '(Disponibile)' : '(Non disponibile)'}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Veicolo selezionato */}
      {selectedVeicolo && (
        <div className="flex items-center gap-4 p-4 bg-white shadow rounded mt-4">
          <img src={selectedVeicolo.immagine} alt={selectedVeicolo.modello} className="w-28 h-28 object-cover rounded" />
          <div className="flex-1 flex flex-col gap-2">
            <span className="font-semibold text-xl">{selectedVeicolo.modello}</span>
            <button
              className={`px-4 py-2 rounded text-white w-max ${
                selectedVeicolo.disponibile ? 'bg-green-600 hover:bg-green-700' : 'bg-red-500 hover:bg-red-600'
              }`}
            >
              {selectedVeicolo.disponibile ? 'Disponibile' : 'Non disponibile'}
            </button>
          </div>
        </div>
      )}

      {/* Mappa */}
      {selectedVeicolo?.coord && (
        <GoogleMap mapContainerStyle={mapContainerStyle} center={selectedVeicolo.coord} zoom={14}>
          <Marker position={selectedVeicolo.coord} label={{ text: selectedVeicolo.modello, color: 'white', fontWeight: 'bold' }} />
        </GoogleMap>
      )}

      {/* Corse giornata */}
      <div className="bg-white shadow rounded p-4 space-y-4 mt-4">
        <h2 className="font-semibold flex items-center gap-2">
          <FaCar /> Corse della giornata
        </h2>
        {corseGiornata.filter((c) => c.veicolo_id === selectedVeicolo?.id).length === 0 && (
          <p className="text-gray-500">Nessuna corsa per questo veicolo oggi.</p>
        )}
        {corseGiornata.filter((c) => c.veicolo_id === selectedVeicolo?.id).map((c) => (
          <div key={c.id} className="border p-3 rounded flex justify-between items-center shadow-sm">
            <div className="flex flex-col">
              <p className="font-medium">{c.cliente}</p>
              <p>
                {c.origine ? `${c.origine.lat.toFixed(5)}, ${c.origine.lon.toFixed(5)}` : 'N/D'} →{' '}
                {c.destinazione ? `${c.destinazione.lat.toFixed(5)}, ${c.destinazione.lon.toFixed(5)}` : 'N/D'}
              </p>
              <p className="text-gray-600">Prezzo: € {c.prezzo.toFixed(2)}</p>
              <p className="text-gray-500 text-sm">Ora: {c.ora}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Pending */}
      <div className="bg-white shadow rounded p-4 space-y-4 mt-4">
        <h2 className="font-semibold flex items-center gap-2">
          <FaCar /> Richieste pendenti
        </h2>
        {pending.length === 0 && <p className="text-gray-500">Nessuna richiesta pendente.</p>}
        {pending.map((c) => {
          const isNew = !seenPendingRef.current.includes(c.id) && c.stato === 'pending';
          const corsaEsistente = corseGiornata.some((g) => g.veicolo_id === selectedVeicolo?.id && g.ora === c.ora);
          return (
            <div key={c.id} className={`border p-3 rounded flex justify-between items-center shadow-sm ${c.stato === 'accettata' ? 'bg-green-50' : ''}`}>
              <div className="flex flex-col">
                <p className="flex items-center gap-2">
                  <span className="font-medium">{c.cliente}</span>
                  {isNew && <span className="animate-pulse bg-red-500 text-white text-xs px-2 py-0.5 rounded-full">NUOVA</span>}
                </p>
                <p>
                  {c.origineStr || 'N/D'} → {c.destinazioneStr || 'N/D'}
                </p>
                <p className="text-gray-600">Prezzo stimato: € {c.prezzo.toFixed(2)}</p>
                {c.passeggeri && <p className="text-gray-700">Passeggeri: {c.passeggeri}</p>}
                <p className="text-gray-500 text-sm">{corsaEsistente ? 'Corsa esistente' : 'Nuova corsa'}</p>
              </div>
              {c.stato === 'pending' ? (
                <button onClick={() => handleAccetta(c.id)} className="bg-green-600 text-white px-4 py-2 rounded hover:bg-green-700">
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
