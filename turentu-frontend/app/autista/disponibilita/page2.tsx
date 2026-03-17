'use client';

import { useEffect, useState } from 'react';
import { useUser } from '../../../context/UserContext';
import GenericTable from '../../../components/DataTable';

const WEEK_DAYS = ['Dom', 'Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab'];

type Veicolo = { id: number; modello: string };
type Inattivita = { start: string; fine: string };
type Disponibilita = {
  id: number;
  veicolo_id: number;
  veicolo_modello: string;
  start: string;
  fine: string;
  giorni_esclusi: number[];
  inattivita: Inattivita[];
};

export default function DisponibilitaPage() {
  const { user } = useUser();
  const [veicoli, setVeicoli] = useState<Veicolo[]>([]);
  const [disponibilita, setDisponibilita] = useState<Disponibilita[]>([]);
  const [loading, setLoading] = useState(true);

  const [editingId, setEditingId] = useState<number | null>(null);
  const [selectedVeicolo, setSelectedVeicolo] = useState<number | null>(null);
  const [start, setStart] = useState('');
  const [fine, setFine] = useState('');
  const [giorniEsclusi, setGiorniEsclusi] = useState<number[]>([]);
  const [inattivita, setInattivita] = useState<Inattivita[]>([]);
  const [newInizioInatt, setNewInizioInatt] = useState('');
  const [newFineInatt, setNewFineInatt] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);

  useEffect(() => {
    if (!user) return;

    fetch(`http://localhost:3001/veicolo?driver_id=${user.id}`, { credentials: 'include' })
      .then(res => res.json())
      .then(data => setVeicoli(data))
      .catch(() => {});

    fetchDisponibilita();
  }, [user]);

  const fetchDisponibilita = async () => {
    try {
      const res = await fetch('http://localhost:3001/disponibilita', { credentials: 'include' });
      if (res.ok) setDisponibilita(await res.json());
    } catch (err) { console.error(err); }
    finally { setLoading(false); }
  };

  const toggleGiorno = (day: number) => {
    setGiorniEsclusi(prev => prev.includes(day) ? prev.filter(d => d !== day) : [...prev, day]);
  };

  const addInattivita = () => {
    if (newInizioInatt && newFineInatt) {
      setInattivita([...inattivita, { start: newInizioInatt, fine: newFineInatt }]);
      setNewInizioInatt('');
      setNewFineInatt('');
    }
  };

  const removeInattivita = (idx: number) => setInattivita(prev => prev.filter((_, i) => i !== idx));

  const formatDateDisplay = (iso: string) => {
    const d = new Date(iso);
    const day = String(d.getDate()).padStart(2, '0');
    const month = d.toLocaleString('en-US', { month: 'short' });
    const year = d.getFullYear();
    return `${day}-${month}-${year}`;
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedVeicolo) return alert('Veicolo non selezionato');

    const inattivitaISO = inattivita.map(i => ({
      start: new Date(i.start).toISOString(),
      fine: new Date(i.fine).toISOString(),
    }));

    try {
      const method = editingId ? 'PUT' : 'POST';
      const url = editingId
        ? `http://localhost:3001/disponibilita/${editingId}`
        : 'http://localhost:3001/disponibilita';

      const res = await fetch(url, {
        method,
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          veicolo_id: selectedVeicolo,
          start,
          fine,
          giorni_esclusi: giorniEsclusi,
          inattivita: inattivitaISO,
        }),
      });

      if (res.ok) {
        resetForm();
        fetchDisponibilita();
      } else {
        const text = await res.text();
        console.error('Errore salvataggio:', text);
        alert('Errore salvataggio: ' + text);
      }
    } catch (err) { console.error(err); }
  };

  const handleEdit = (d: Disponibilita) => {
    setEditingId(d.id);
    setSelectedVeicolo(d.veicolo_id);
    setStart(d.start);
    setFine(d.fine);
    setGiorniEsclusi(d.giorni_esclusi);
    setInattivita(d.inattivita);
    setIsModalOpen(true);
  };

  const resetForm = () => {
    setEditingId(null);
    setSelectedVeicolo(null);
    setStart(''); setFine('');
    setGiorniEsclusi([]); setInattivita([]);
    setNewInizioInatt(''); setNewFineInatt('');
    setIsModalOpen(false);
  };

  if (loading) return <p>Caricamento disponibilità...</p>;

  const columns = [
    {
      key: 'turno',
      header: 'Turno',
      render: (row: Disponibilita) => {
        const startTime = new Date(row.start);
        const endTime = new Date(row.fine);
        const formatHM = (d: Date) => `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
        return `Dalle ${formatHM(startTime)} alle ${formatHM(endTime)}`;
      }
    },
    {
      key: 'giorni_esclusi',
      header: 'Giorni esclusi',
      render: r => r.giorni_esclusi.length ? r.giorni_esclusi.map(i => WEEK_DAYS[i]).join(', ') : '-'
    },
    {
      key: 'inattivita',
      header: 'Inattività',
      render: r => r.inattivita.length
        ? r.inattivita.map(i => `Dal ${formatDateDisplay(i.start)} al ${formatDateDisplay(i.fine)}`).join('; ')
        : '-'
    }
  ];

  return (
    <div className="p-4 max-w-3xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold mb-4">Orari di Disponibilità</h1>

      {/* MODAL */}
      {isModalOpen && (
        <div className="fixed inset-0 flex items-center justify-center z-50">
          <div
            className="absolute inset-0 bg-black bg-opacity-50 backdrop-blur-sm"
            onClick={resetForm}
          />
          <div className="relative bg-white w-full max-w-lg rounded-xl shadow-2xl p-6 z-10 animate-fadeIn">
            <h2 className="text-lg font-semibold mb-4">Modifica Turno</h2>

            <form onSubmit={handleSave} className="space-y-4">
              <input type="hidden" value={selectedVeicolo ?? ''} />

              {/* Start / Fine */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm">Ora inizio:</label>
                  <input
                    type="time"
                    value={start}
                    onChange={e => setStart(e.target.value)}
                    className="border p-2 rounded w-full"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm">Ora fine:</label>
                  <input
                    type="time"
                    value={fine}
                    onChange={e => setFine(e.target.value)}
                    className="border p-2 rounded w-full"
                    required
                  />
                </div>
              </div>

              {/* Giorni esclusi */}
              <div>
                <label className="block text-sm mb-1">Giorni esclusi:</label>
                <div className="flex flex-wrap gap-1">
                  {WEEK_DAYS.map((d, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => toggleGiorno(i)}
                      className={`px-2 py-1 text-xs rounded font-medium border transition ${
                        giorniEsclusi.includes(i)
                          ? 'bg-red-600 text-white border-red-600'
                          : 'bg-gray-100 text-gray-800 border-gray-300'
                      }`}
                    >
                      {d}
                    </button>
                  ))}
                </div>
              </div>

              {/* Inattività */}
              <div>
                <label className="block text-sm mb-1">Periodo di Inattività:</label>
                <div className="flex flex-col gap-1 mb-2">
                  {inattivita.map((i, idx) => (
                    <div
                      key={idx}
                      className="flex justify-between items-center gap-2 bg-red-100 px-2 py-1 rounded text-xs text-red-800"
                    >
                      <span>
                        Dal {formatDateDisplay(i.start)} al {formatDateDisplay(i.fine)}
                      </span>
                      <button
                        type="button"
                        onClick={() => removeInattivita(idx)}
                        className="text-red-600 hover:underline text-[0.6rem]"
                      >
                        Rimuovi
                      </button>
                    </div>
                  ))}
                </div>

                <div className="flex gap-2">
                  <input
                    type="date"
                    value={newInizioInatt}
                    onChange={e => setNewInizioInatt(e.target.value)}
                    className="border p-1 rounded w-1/2"
                  />
                  <input
                    type="date"
                    value={newFineInatt}
                    onChange={e => setNewFineInatt(e.target.value)}
                    className="border p-1 rounded w-1/2"
                  />
                  <button
                    type="button"
                    onClick={addInattivita}
                    className="bg-red-600 text-white px-3 py-1 rounded hover:bg-red-700 transition text-sm"
                  >
                    Aggiungi
                  </button>
                </div>
              </div>

              {/* Pulsanti */}
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={resetForm}
                  className="bg-gray-400 text-white px-4 py-2 rounded hover:bg-gray-500 transition"
                >
                  Annulla
                </button>
                <button
                  type="submit"
                  className="bg-green-500 text-white px-4 py-2 rounded hover:bg-green-600 transition-all duration-200"
                >
                  Salva
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <GenericTable
        data={disponibilita}
        layout="inline"
        columns={columns}
        actions={(row) => (
          <button
            className="bg-emerald-500 text-white px-3 py-1 rounded-md shadow-sm hover:bg-emerald-600 hover:shadow-md transition-all duration-200"
            onClick={() => handleEdit(row)}
          >
            Modifica
          </button>
        )}
      />
    </div>
  );
}
