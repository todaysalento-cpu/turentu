'use client';

import { useEffect, useState, useMemo, useRef } from 'react';
import { useUser } from '../../../context/UserContext';
import { io } from 'socket.io-client';
import { MapPinIcon } from 'lucide-react';

const SOCKET_URL = 'http://localhost:3001';

export default function LivePage() {
  const { user } = useUser();

  const [veicoli, setVeicoli] = useState([]);
  const [selectedVeicoloId, setSelectedVeicoloId] = useState(null);
  const [pending, setPending] = useState([]);
  const [corseGiornata, setCorseGiornata] = useState([]);
  const socketRef = useRef(null);

  const selectedVeicolo = veicoli.find(v => v.id === selectedVeicoloId) || veicoli[0];

  const corseFiltrate = useMemo(() => {
    if (!selectedVeicolo) return [];
    return corseGiornata.filter(c => Number(c.veicolo_id) === Number(selectedVeicolo.id));
  }, [selectedVeicolo, corseGiornata]);

  // SOCKET
  useEffect(() => {
    if (!user) return;

    const socket = io(SOCKET_URL, { withCredentials: true });
    socketRef.current = socket;

    socket.emit('join_autista', user.id);

    socket.on('pending_update', c => {
      const updated = { ...c, prezzo: Number(c.prezzo) || 0 };
      setPending(prev => {
        const exists = prev.find(p => p.id === updated.id);
        if (!exists) return [updated, ...prev];
        return prev.map(p => (p.id === updated.id ? updated : p));
      });
    });

    return () => socket.disconnect();
  }, [user]);

  // FETCH
  useEffect(() => {
    if (!user) return;

    const fetchData = async () => {
      try {
        // Corse giornata
        const resG = await fetch(`http://localhost:3001/corse/autista/today/${user.id}`, {
          credentials: 'include',
        });
        const dataG = await resG.json();
        setCorseGiornata(
          Array.isArray(dataG)
            ? dataG.map(c => ({ ...c, prezzo: Number(c.prezzo) || 0 }))
            : []
        );

        // Veicoli
        const resV = await fetch(`http://localhost:3001/veicolo`, { credentials: 'include' });
        const dataV = await resV.json();
        const veicoliLive = Array.isArray(dataV)
          ? dataV.map(v => ({
              id: v.id,
              modello: v.modello || 'Veicolo sconosciuto',
              immagine:
                v.immagine ||
                'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcSkjvs92_ZNpPDL0dULuabY4ChUQpo4OLPl2A&s',
              disponibile: true,
            }))
          : [];
        setVeicoli(veicoliLive);
        setSelectedVeicoloId(veicoliLive[0]?.id || null);

        // Pending
        const resP = await fetch(`http://localhost:3001/pending/autista/${user.id}`, {
          credentials: 'include',
        });
        const dataP = await resP.json();
        setPending(Array.isArray(dataP) ? dataP.map(c => ({ ...c, prezzo: Number(c.prezzo) || 0 })) : []);
      } catch (err) {
        console.error('Errore fetch:', err);
      }
    };

    fetchData();
  }, [user]);

  const getLocalita = (c, address) => (!c ? 'N/D' : address || `${Number(c.lat).toFixed(5)}, ${Number(c.lon).toFixed(5)}`);

  const handleAccetta = async id => {
    await fetch(`http://localhost:3001/pending/${id}/accetta`, { method: 'POST', credentials: 'include' });
    setPending(prev => prev.map(c => (c.id === id ? { ...c, stato: 'accettata' } : c)));
  };

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-8">
      {/* Veicolo */}
      <div className="flex items-center space-x-4 bg-gray-100 p-4 rounded shadow">
        {selectedVeicolo?.immagine && (
          <img src={selectedVeicolo.immagine} className="w-20 h-20 object-cover rounded" />
        )}
        <div>
          <h2 className="text-xl font-semibold">Veicolo selezionato</h2>
          <p>{selectedVeicolo?.modello || 'N/D'}</p>
        </div>
      </div>

      {/* Pending */}
      <section>
        <h3 className="text-lg font-semibold mb-3">Richieste da accettare</h3>
        {pending.length === 0 ? (
          <p className="text-gray-500">Nessun pending</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {pending.map(c => {
              const corsaEsistente = corseFiltrate.some(g => g.ora === c.ora);
              return (
                <div
                  key={c.id}
                  className={`p-4 border-l-4 rounded shadow transition ${
                    c.stato === 'accettata'
                      ? 'bg-green-50 border-green-500'
                      : 'bg-yellow-50 border-yellow-400 hover:bg-yellow-100'
                  }`}
                >
                  <p className="font-semibold">{c.cliente}</p>

                  <p className="flex items-center gap-2 text-sm mt-2">
                    <MapPinIcon className="w-4 h-4" />
                    Origine: {getLocalita(c.origine, c.origineAddress)}
                  </p>

                  <p className="flex items-center gap-2 text-sm">
                    <MapPinIcon className="w-4 h-4 text-red-600" />
                    Destinazione: {getLocalita(c.destinazione, c.destinazioneAddress)}
                  </p>

                  <p className="font-semibold mt-2">€{c.prezzo.toFixed(2)}</p>

                  {c.passeggeri && <p className="text-sm text-gray-600">Passeggeri: {c.passeggeri}</p>}

                  {corsaEsistente && <p className="text-xs text-orange-600 mt-1">⚠️ Corsa già presente</p>}

                  {c.stato !== 'accettata' ? (
                    <button
                      onClick={() => handleAccetta(c.id)}
                      className="mt-3 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 transition"
                    >
                      Accetta
                    </button>
                  ) : (
                    <span className="text-green-700 font-semibold block mt-2">Accettata</span>
                  )}
                </div>
              );
            })}
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
                <p className="flex items-center gap-2 text-sm">
                  <MapPinIcon className="w-4 h-4" />
                  Origine: {getLocalita(c.origine, c.origineAddress)}
                </p>
                <p className="flex items-center gap-2 text-sm">
                  <MapPinIcon className="w-4 h-4 text-red-600" />
                  Destinazione: {getLocalita(c.destinazione, c.destinazioneAddress)}
                </p>
                <p className="font-semibold mt-1">€{c.prezzo.toFixed(2)}</p>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
