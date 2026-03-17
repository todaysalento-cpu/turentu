'use client';
import { useState, useEffect } from 'react';

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

  // Form
  const [modello, setModello] = useState('');
  const [posti, setPosti] = useState(4);
  const [euroKm, setEuroKm] = useState(1);
  const [raggioKm, setRaggioKm] = useState(50);
  const [targa, setTarga] = useState('');
  const [prezzoPasseggero, setPrezzoPasseggero] = useState(1);
  const [servizi, setServizi] = useState<string[]>([]);

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

  const toggleServizio = (servizio: string) => {
    setServizi((prev) =>
      prev.includes(servizio)
        ? prev.filter((s) => s !== servizio)
        : [...prev, servizio]
    );
  };

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch('http://localhost:3001/veicolo', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modello,
          posti_totali: posti,
          euro_km: euroKm,
          raggio_km: raggioKm,
          targa,
          prezzo_passeggero: prezzoPasseggero,
          servizi,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Errore server');
      }

      const nuovoVeicolo = await res.json();

      setVeicoli([
        {
          ...nuovoVeicolo,
          servizi: Array.isArray(nuovoVeicolo.servizi)
            ? nuovoVeicolo.servizi
            : [],
        },
        ...veicoli,
      ]);

      setShowForm(false);
      setModello('');
      setPosti(4);
      setEuroKm(1);
      setRaggioKm(50);
      setTarga('');
      setPrezzoPasseggero(1);
      setServizi([]);
      setMsg('Veicolo aggiunto ✅');
    } catch (err) {
      console.error(err);
      setMsg((err as Error).message);
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
        <form onSubmit={handleAdd} className="bg-white p-4 rounded shadow space-y-3">
          <input className="border p-1 w-full" placeholder="Modello" value={modello} onChange={(e) => setModello(e.target.value)} required />
          <input className="border p-1 w-full" type="number" value={posti} onChange={(e) => setPosti(+e.target.value)} />
          <input className="border p-1 w-full" type="number" step="0.01" value={euroKm} onChange={(e) => setEuroKm(+e.target.value)} />
          <input className="border p-1 w-full" type="number" value={raggioKm} onChange={(e) => setRaggioKm(+e.target.value)} />
          <input className="border p-1 w-full" placeholder="Targa" value={targa} onChange={(e) => setTarga(e.target.value)} />
          <input className="border p-1 w-full" type="number" step="0.01" value={prezzoPasseggero} onChange={(e) => setPrezzoPasseggero(+e.target.value)} />

          <div>
            <p className="font-medium mb-1">Servizi</p>
            <div className="grid grid-cols-2 gap-2">
              {SERVIZI_DISPONIBILI.map((s) => (
                <label key={s} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={servizi.includes(s)} onChange={() => toggleServizio(s)} />
                  {s}
                </label>
              ))}
            </div>
          </div>

          <button className="bg-blue-600 text-white px-3 py-1 rounded">Salva</button>
        </form>
      )}

      <table className="w-full mt-6 border">
        <thead className="bg-gray-100">
          <tr>
            <th className="border p-2">Modello</th>
            <th className="border p-2">Posti</th>
            <th className="border p-2">€/km</th>
            <th className="border p-2">Raggio</th>
            <th className="border p-2">Targa</th>
            <th className="border p-2">Prezzo</th>
            <th className="border p-2">Servizi</th>
            <th className="border p-2">Azioni</th>
          </tr>
        </thead>
        <tbody>
          {veicoli.map((v) => (
            <tr key={v.id} className="text-center">
              <td className="border p-2">{v.modello}</td>
              <td className="border p-2">{v.posti_totali}</td>
              <td className="border p-2">{v.euro_km}</td>
              <td className="border p-2">{v.raggio_km}</td>
              <td className="border p-2">{v.targa || '-'}</td>
              <td className="border p-2">{v.prezzo_passeggero}</td>
              <td className="border p-2">{v.servizi.join(', ') || '-'}</td>
              <td className="border p-2">
                <button onClick={() => handleDelete(v.id)} className="text-red-600">
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
