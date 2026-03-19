'use client';
import { useState, useEffect } from 'react';
import VeicoloForm from '../../../components/VeicoloForm';
import VeicoloCardTable from '../../../components/VeicoloCardTable';
import { Veicolo } from '@/types/veicolo'; // <- import condiviso

export default function VeicoloPage() {
  const [veicoli, setVeicoli] = useState<Veicolo[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);
  const [editingVeicolo, setEditingVeicolo] = useState<Veicolo | null>(null);
  const [showFormPopup, setShowFormPopup] = useState(false);

  useEffect(() => {
    fetchVeicoli();
  }, []);

  const fetchVeicoli = async () => {
    setLoading(true);
    try {
      const res = await fetch('http://localhost:3001/veicolo', { credentials: 'include' });
      if (!res.ok) throw new Error('Errore fetch veicoli');
      const data: Veicolo[] = await res.json();
      setVeicoli(data);
    } catch (err) {
      console.error(err);
      setMsg('Errore caricamento veicoli');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = (v: Veicolo) => {
    if (editingVeicolo) {
      setVeicoli(prev => prev.map(item => (item.id === v.id ? v : item)));
      setMsg('Veicolo aggiornato ✅');
    } else {
      setVeicoli(prev => [v, ...prev]);
      setMsg('Veicolo aggiunto ✅');
    }
    setShowFormPopup(false);
    setEditingVeicolo(null);
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Eliminare veicolo?')) return;
    try {
      const res = await fetch(`http://localhost:3001/veicolo/${id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Errore delete');
      setVeicoli(prev => prev.filter(v => v.id !== id));
      setMsg('Veicolo eliminato ✅');
    } catch (err) {
      console.error(err);
      setMsg('Errore eliminazione');
    }
  };

  const handleEdit = (v: Veicolo) => {
    setEditingVeicolo(v);
    setShowFormPopup(true);
  };

  const handleAdd = () => {
    setEditingVeicolo(null);
    setShowFormPopup(true);
  };

  return (
    <div className="p-4">
      <div className="flex flex-col sm:flex-row sm:items-center gap-2 mb-6">
        <h1 className="text-2xl font-bold">I miei veicoli</h1>
        <button
          onClick={handleAdd}
          className="bg-green-600 text-white px-3 py-1 rounded-md text-sm hover:bg-green-700 transition self-start sm:self-auto"
        >
          Aggiungi veicolo
        </button>
      </div>

      {msg && <p className="mb-3 text-sm text-green-700">{msg}</p>}

      {loading ? (
        <p>Caricamento...</p>
      ) : (
        <VeicoloCardTable veicoli={veicoli} onDelete={handleDelete} onEdit={handleEdit} />
      )}

      {showFormPopup && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
          <div className="absolute inset-0 bg-gray-100/30 pointer-events-auto"></div>

          <div className="relative bg-white rounded-xl shadow-lg w-full max-w-md pointer-events-auto">
            <button
              className="absolute top-3 right-3 text-gray-600 hover:text-black z-10"
              onClick={() => setShowFormPopup(false)}
            >
              ✕
            </button>

            <VeicoloForm
              veicolo={editingVeicolo ?? undefined}
              onSave={handleSave}
              onCancel={() => setShowFormPopup(false)}
            />
          </div>
        </div>
      )}
    </div>
  );
}