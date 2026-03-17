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

  const corseFiltrate = useMemo(
    () => (selectedVeicolo ? corseGiornata.filter(c => Number(c.veicolo_id) === Number(selectedVeicolo.id)) : []),
    [selectedVeicolo, corseGiornata]
  );

  // ---------------- SOCKET ----------------
  useEffect(() => {
    if (!user) return;

    const socket = io(SOCKET_URL, { withCredentials: true });
    socketRef.current = socket;
    socket.emit('join_autista', user.id);

    socket.on('pending_update', c => {
      setPending(prev => {
        const exists = prev.find(p => p.id === c.id);
        return exists ? prev.map(p => (p.id === c.id ? c : p)) : [c, ...prev];
      });
    });

    return () => socket.disconnect();
  }, [user]);

  // ---------------- FETCH ----------------
  useEffect(() => {
    if (!user || !selectedVeicolo) return;

    const fetchData = async () => {
      try {
        const [resG, resV, resP] = await Promise.all([
          fetch(`http://localhost:3001/corse/autista/today/${user.id}`, { credentials: 'include' }),
          fetch(`http://localhost:3001/veicolo`, { credentials: 'include' }),
          fetch(`http://localhost:3001/pending/autista/${selectedVeicolo.id}`, { credentials: 'include' }),
        ]);

        if (!resG.ok || !resV.ok || !resP.ok) throw new Error('Errore nel fetch dati backend');

        const [dataG, dataV, dataP] = await Promise.all([resG.json(), resV.json(), resP.json()]);

        setCorseGiornata(Array.isArray(dataG) ? dataG : []);
        setVeicoli(Array.isArray(dataV) ? dataV.map(v => ({
          id: v.id,
          modello: v.modello || 'Veicolo sconosciuto',
          immagine: v.immagine || 'https://via.placeholder.com/80',
        })) : []);

        setSelectedVeicoloId(prev => prev || dataV?.[0]?.id || null);
        setPending(Array.isArray(dataP?.pendings) ? dataP.pendings : []);
      } catch (err) {
        console.error('Errore fetch:', err);
      }
    };

    fetchData();
  }, [user, selectedVeicolo]);

  const handleAccetta = async id => {
    try {
      const res = await fetch(`http://localhost:3001/pending/${id}/accetta`, { method: 'POST', credentials: 'include' });
      if (!res.ok) throw new Error('Errore accettazione pending');
      const accepted = (await res.json())?.pendings?.[0];
      if (accepted) setPending(prev => prev.map(c => (c.id === id ? accepted : c)));
    } catch (err) {
      console.error('Errore accetta:', err);
    }
  };

  const formatAddress = (address) => address || 'N/D';

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-8">
      {selectedVeicolo && (
        <div className="flex items-center space-x-4 bg-gray-100 p-4 rounded shadow">
          {selectedVeicolo.immagine && <img src={selectedVeicolo.immagine} className="w-20 h-20 object-cover rounded" />}
          <div>
            <h2 className="text-xl font-semibold">Veicolo selezionato</h2>
            <p>{selectedVeicolo.modello}</p>
          </div>
        </div>
      )}

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
                  className={`p-4 border-l-4 rounded shadow transition ${c.stato === 'accettata' ? 'bg-green-50 border-green-500' : 'bg-yellow-50 border-yellow-400 hover:bg-yellow-100'}`}
                >
                  <p className="font-semibold">{c.cliente}</p>
                  <p className="flex items-center gap-2 text-sm mt-2">
                    <MapPinIcon className="w-4 h-4" /> Origine: {formatAddress(c.origine_address)}
                  </p>
                  <p className="flex items-center gap-2 text-sm">
                    <MapPinIcon className="w-4 h-4 text-red-600" /> Destinazione: {formatAddress(c.destinazione_address)}
                  </p>
                  <p className="font-semibold mt-2">€{c.prezzo?.toFixed(2)}</p>
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
                  <MapPinIcon className="w-4 h-4" /> Origine: {formatAddress(c.origine_address)}
                </p>
                <p className="flex items-center gap-2 text-sm">
                  <MapPinIcon className="w-4 h-4 text-red-600" /> Destinazione: {formatAddress(c.destinazione_address)}
                </p>
                <p className="font-semibold mt-1">€{c.prezzo?.toFixed(2)}</p>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
