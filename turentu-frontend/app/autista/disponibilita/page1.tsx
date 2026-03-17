'use client';
import { useEffect, useState } from 'react';
import { useUser } from '../../../context/UserContext';

const WEEK_DAYS = ['Dom', 'Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab'];

type Veicolo = {
  id: number;
  modello: string;
};

type Disponibilita = {
  id: number;
  veicolo_id: number;
  veicolo_modello: string;
  start: string;
  fine: string;
  manual: boolean;
  giorni_esclusi: number[];
  inattivita: { start: string; fine: string }[];
};

export default function DisponibilitaPage() {
  const { user } = useUser();
  const [veicoli, setVeicoli] = useState<Veicolo[]>([]);
  const [disponibilita, setDisponibilita] = useState<Disponibilita[]>([]);
  const [loading, setLoading] = useState(true);

  const [newVeicolo, setNewVeicolo] = useState<number | null>(null);
  const [newStart, setNewStart] = useState('');
  const [newFine, setNewFine] = useState('');
  const [manual, setManual] = useState(false);
  const [giorniEsclusi, setGiorniEsclusi] = useState<number[]>([]);
  const [inattivita, setInattivita] = useState<{ start: string; fine: string }[]>([]);
  const [newInizioInatt, setNewInizioInatt] = useState('');
  const [newFineInatt, setNewFineInatt] = useState('');

  useEffect(() => {
    if (!user) return;

    // Fetch veicoli autista
    fetch(`http://localhost:3001/veicolo?driver_id=${user.id}`, { credentials: 'include' })
      .then(res => res.json())
      .then(data => setVeicoli(data))
      .catch(() => {});

    fetchDisponibilita();
  }, [user]);

  const fetchDisponibilita = async () => {
    try {
      const res = await fetch('http://localhost:3001/disponibilita', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setDisponibilita(data);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const toggleGiorno = (day: number) => {
    setGiorniEsclusi((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]
    );
  };

  const addInattivita = () => {
    if (newInizioInatt && newFineInatt) {
      setInattivita([...inattivita, { start: newInizioInatt, fine: newFineInatt }]);
      setNewInizioInatt('');
      setNewFineInatt('');
    }
  };

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newVeicolo) return alert('Seleziona un veicolo');
    try {
      const res = await fetch('http://localhost:3001/disponibilita', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          veicolo_id: newVeicolo,
          start: newStart,
          fine: newFine,
          manual,
          giorni_esclusi: giorniEsclusi,
          inattivita,
        }),
      });
      if (res.ok) {
        setNewStart('');
        setNewFine('');
        setManual(false);
        setGiorniEsclusi([]);
        setInattivita([]);
        fetchDisponibilita();
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleDelete = async (id: number) => {
    try {
      const res = await fetch(`http://localhost:3001/disponibilita/${id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (res.ok) fetchDisponibilita();
    } catch (err) {
      console.error(err);
    }
  };

  if (loading) return <p>Caricamento disponibilità...</p>;

  return (
    <div className="p-4 max-w-3xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold mb-4">Orari di Disponibilità</h1>

      {/* FORM */}
      <form onSubmit={handleAdd} className="mb-6 space-y-4 p-4 bg-white shadow rounded">
        <h2 className="font-semibold">Aggiungi Turno</h2>

        <div>
          <label className="block text-sm">Seleziona Veicolo:</label>
          <select
            value={newVeicolo || ''}
            onChange={e => setNewVeicolo(Number(e.target.value))}
            className="border p-1 rounded w-full"
            required
          >
            <option value="">-- Scegli veicolo --</option>
            {veicoli.map(v => (
              <option key={v.id} value={v.id}>{v.modello}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm">Ora inizio:</label>
          <input
            type="time"
            value={newStart}
            onChange={(e) => setNewStart(e.target.value)}
            className="border p-1 rounded w-full"
            required
          />
        </div>

        <div>
          <label className="block text-sm">Ora fine:</label>
          <input
            type="time"
            value={newFine}
            onChange={(e) => setNewFine(e.target.value)}
            className="border p-1 rounded w-full"
            required
          />
        </div>

        <div className="flex items-center space-x-2">
          <input type="checkbox" checked={manual} onChange={(e) => setManual(e.target.checked)} />
          <span>Manuale</span>
        </div>

        <div>
          <label className="block text-sm">Giorni esclusi:</label>
          <div className="flex gap-2 mt-1">
            {WEEK_DAYS.map((d, i) => (
              <button
                type="button"
                key={i}
                onClick={() => toggleGiorno(i)}
                className={`px-2 py-1 border rounded ${
                  giorniEsclusi.includes(i) ? 'bg-red-600 text-white' : 'bg-white'
                }`}
              >
                {d}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-sm">Aggiungi periodo di inattività:</label>
          <div className="flex gap-2 mt-1">
            <input
              type="time"
              value={newInizioInatt}
              onChange={(e) => setNewInizioInatt(e.target.value)}
              className="border p-1 rounded"
            />
            <input
              type="time"
              value={newFineInatt}
              onChange={(e) => setNewFineInatt(e.target.value)}
              className="border p-1 rounded"
            />
            <button
              type="button"
              onClick={addInattivita}
              className="bg-gray-600 text-white px-2 py-1 rounded"
            >
              Aggiungi
            </button>
          </div>
          {inattivita.length > 0 && (
            <ul className="mt-2 text-sm">
              {inattivita.map((i, idx) => (
                <li key={idx} className="text-red-600">
                  {i.start} - {i.fine}
                </li>
              ))}
            </ul>
          )}
        </div>

        <button className="bg-red-600 text-white px-3 py-1 rounded hover:bg-red-700">
          Salva Turno
        </button>
      </form>

      {/* TABELLA TURNI */}
      <table className="min-w-full border border-gray-200 bg-white shadow rounded">
        <thead className="bg-gray-100">
          <tr>
            <th className="p-2 border">Veicolo</th>
            <th className="p-2 border">Turno</th>
            <th className="p-2 border">Manuale</th>
            <th className="p-2 border">Giorni esclusi</th>
            <th className="p-2 border">Inattività</th>
            <th className="p-2 border">Azioni</th>
          </tr>
        </thead>
        <tbody>
          {disponibilita.map((d) => (
            <tr key={d.id} className="text-center">
              <td className="p-2 border">{d.veicolo_modello}</td>
              <td className="p-2 border">{d.start} - {d.fine}</td>
              <td className="p-2 border">{d.manual ? 'Sì' : 'No'}</td>
              <td className="p-2 border">
                {d.giorni_esclusi.length > 0
                  ? d.giorni_esclusi.map((i) => WEEK_DAYS[i]).join(', ')
                  : '-'}
              </td>
              <td className="p-2 border">
                {d.inattivita.length > 0 ? (
                  <div className="flex flex-wrap justify-center gap-1">
                    {d.inattivita.map((i, idx) => (
                      <span
                        key={idx}
                        className="bg-red-200 text-red-800 px-2 py-1 rounded text-xs"
                      >
                        {i.start} - {i.fine}
                      </span>
                    ))}
                  </div>
                ) : '-'}
              </td>
              <td className="p-2 border">
                <button
                  onClick={() => handleDelete(d.id)}
                  className="bg-red-600 text-white px-2 py-1 rounded hover:bg-red-700"
                >
                  Elimina
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
