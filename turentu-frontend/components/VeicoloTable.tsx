'use client';
import { useState, useEffect } from 'react';
import GenericTable from '../../../components/GenericTable';
import VeicoloForm from '../../../components/VeicoloForm';

const SERVIZI_DISPONIBILI = [
  'WiFi',
  'Aria condizionata',
  'Animali ammessi',
  'Bagagliaio grande',
  'USB',
  'Seggiolino bambini',
];

export default function VeicoloPage() {
  const [veicoli, setVeicoli] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    fetchVeicoli();
  }, []);

  const fetchVeicoli = async () => {
    setLoading(true);
    try {
      const res = await fetch('http://localhost:3001/veicolo', {
        credentials: 'include',
      });

      if (!res.ok) throw new Error('Errore fetch');

      const data = await res.json();

      // normalizza servizi
      const normalizzati = data.map((v: any) => ({
        ...v,
        servizi: Array.isArray(v.servizi)
          ? v.servizi
          : typeof v.servizi === 'string'
          ? v.servizi.split(',').map((s: string) => s.trim())
          : [],
      }));

      setVeicoli(normalizzati);
    } catch (err) {
      console.error(err);
      setMsg('Errore nel caricamento veicoli');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Eliminare veicolo?')) return;

    try {
      const res = await fetch(`http://localhost:3001/veicolo/${id}`, {
        method: 'DELETE',
        credentials: 'include',
      });

      if (!res.ok) throw new Error('Errore delete');

      setVeicoli((prev) => prev.filter((v) => v.id !== id));
      setMsg('Veicolo eliminato ✅');
    } catch (err) {
      console.error(err);
      setMsg('Errore eliminazione');
    }
  };

  if (loading) return <p>Caricamento...</p>;

  const columns = [
    { key: 'modello', header: 'Modello' },
    { key: 'posti_totali', header: 'Posti' },
    { key: 'raggio_km', header: 'Raggio km' },
    { key: 'targa', header: 'Targa' },
    { key: 'servizi', header: 'Servizi', render: (row: any) => row.servizi.join(', ') || '-' },
  ];

  return (
    <div className="p-4">
      <div className="flex justify-between mb-4">
        <h1 className="text-2xl font-bold">I miei veicoli</h1>
        <button
          onClick={() => setShowForm(!showForm)}
          className="bg-green-600 text-white px-3 py-1 rounded"
        >
          {showForm ? 'Chiudi' : 'Aggiungi'}
        </button>
      </div>

      {msg && <p className="mb-2 text-sm text-green-700">{msg}</p>}

      {showForm && (
        <VeicoloForm
          onSave={(nuovoVeicolo) => {
            setVeicoli([nuovoVeicolo, ...veicoli]);
            setShowForm(false);
            setMsg('Veicolo aggiunto ✅');
          }}
        />
      )}

      <GenericTable
        data={veicoli}
        columns={columns}
        actions={(row: any) => (
          <button
            onClick={() => handleDelete(row.id)}
            className="bg-red-600 text-white px-2 py-1 rounded"
          >
            Elimina
          </button>
        )}
      />
    </div>
  );
}
