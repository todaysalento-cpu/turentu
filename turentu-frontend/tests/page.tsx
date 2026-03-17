'use client';
import { useState, useEffect } from 'react';

type Veicolo = {
  id: number;
  modello: string;
  euro_km: number;
  prezzo_passeggero: number;
};

export default function TariffePage() {
  const [veicoli, setVeicoli] = useState<Veicolo[]>([]);
  const [loading, setLoading] = useState(true);

  const [editingId, setEditingId] = useState<number | null>(null);
  const [euroKm, setEuroKm] = useState(0);
  const [prezzoPasseggero, setPrezzoPasseggero] = useState(0);

  useEffect(() => {
    fetchVeicoli();
  }, []);

  const fetchVeicoli = async () => {
    try {
      const res = await fetch('http://localhost:3001/veicolo', { credentials: 'include' });
      if (res.ok) {
        setVeicoli(await res.json());
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleEdit = (v: Veicolo) => {
    setEditingId(v.id);
    setEuroKm(v.euro_km);
    setPrezzoPasseggero(v.prezzo_passeggero);
  };

  const handleSave = async (id: number) => {
    try {
      const res = await fetch(`http://localhost:3001/veicolo/${id}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ euro_km: euroKm, prezzo_passeggero: prezzoPasseggero }),
      });
      if (res.ok) {
        setEditingId(null);
        fetchVeicoli();
      }
    } catch (err) {
      console.error(err);
    }
  };

  if (loading) return <p>Caricamento tariffe...</p>;

  return (
    <div className="p-4">
      <h1 className="text-2xl font-bold mb-4">Tariffe Veicoli</h1>

      <table className="min-w-full border border-gray-200 bg-white shadow rounded">
        <thead className="bg-gray-100">
          <tr>
            <th className="p-2 border">Modello</th>
            <th className="p-2 border">Euro/km</th>
            <th className="p-2 border">Prezzo Passeggero</th>
            <th className="p-2 border">Azioni</th>
          </tr>
        </thead>
        <tbody>
          {veicoli.map((v) => (
            <tr key={v.id} className="text-center">
              <td className="p-2 border">{v.modello}</td>

              <td className="p-2 border">
                {editingId === v.id ? (
                  <input
                    type="number"
                    value={euroKm}
                    onChange={(e) => setEuroKm(parseFloat(e.target.value))}
                    className="border p-1 rounded w-20"
                    step={0.01}
                  />
                ) : (
                  v.euro_km.toFixed(2)
                )}
              </td>

              <td className="p-2 border">
                {editingId === v.id ? (
                  <input
                    type="number"
                    value={prezzoPasseggero}
                    onChange={(e) => setPrezzoPasseggero(parseFloat(e.target.value))}
                    className="border p-1 rounded w-20"
                    step={0.01}
                  />
                ) : (
                  v.prezzo_passeggero.toFixed(2)
                )}
              </td>

              <td className="p-2 border">
                {editingId === v.id ? (
                  <button
                    onClick={() => handleSave(v.id)}
                    className="bg-red-600 text-white px-2 py-1 rounded hover:bg-red-700"
                  >
                    Salva
                  </button>
                ) : (
                  <button
                    onClick={() => handleEdit(v)}
                    className="bg-blue-600 text-white px-2 py-1 rounded hover:bg-blue-700"
                  >
                    Modifica
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
