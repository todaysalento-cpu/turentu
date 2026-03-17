'use client';
import { useEffect, useState } from 'react';

type Corsa = {
  id: number;
  cliente: string;
  autista: string;
  prezzo: number;
  stato: string;
};

type DashboardData = {
  ricavi_giorno: number;
  ricavi_mese: number;
  commissioni: number;
  ultime_corse?: Corsa[];
};

export default function AdminDashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const res = await fetch('http://localhost:3001/admin/dashboard', { credentials: 'include' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json: DashboardData = await res.json();
        setData(json);
      } catch (err: any) {
        console.error('Errore fetch dashboard:', err);
        setError('Impossibile caricare i dati della dashboard.');
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, []);

  if (loading) return <p>Caricamento dashboard...</p>;
  if (error) return <p className="text-red-600">{error}</p>;

  return (
    <div className="p-4 space-y-6">
      <h1 className="text-2xl font-bold mb-4">Dashboard Admin</h1>

      {/* KPI */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <div className="bg-white p-4 rounded shadow">
          <p className="text-gray-500">Ricavi oggi</p>
          <p className="text-2xl font-bold">€{data?.ricavi_giorno ?? 0}</p>
        </div>
        <div className="bg-white p-4 rounded shadow">
          <p className="text-gray-500">Ricavi mese</p>
          <p className="text-2xl font-bold">€{data?.ricavi_mese ?? 0}</p>
        </div>
        <div className="bg-white p-4 rounded shadow">
          <p className="text-gray-500">Commissioni</p>
          <p className="text-2xl font-bold">€{data?.commissioni ?? 0}</p>
        </div>
      </div>

      {/* Ultime corse */}
      <div className="bg-white p-4 rounded shadow overflow-x-auto">
        <h2 className="font-bold mb-2">Ultime Corse</h2>
        {data?.ultime_corse?.length ? (
          <table className="w-full text-left border">
            <thead>
              <tr className="border-b">
                <th className="px-2 py-1">ID</th>
                <th className="px-2 py-1">Cliente</th>
                <th className="px-2 py-1">Autista</th>
                <th className="px-2 py-1">Prezzo</th>
                <th className="px-2 py-1">Stato</th>
              </tr>
            </thead>
            <tbody>
              {data.ultime_corse.map((c) => (
                <tr key={c.id} className="border-b hover:bg-gray-50">
                  <td className="px-2 py-1">{c.id}</td>
                  <td className="px-2 py-1">{c.cliente}</td>
                  <td className="px-2 py-1">{c.autista}</td>
                  <td className="px-2 py-1">€{c.prezzo}</td>
                  <td className="px-2 py-1">{c.stato}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-gray-500">Nessuna corsa recente.</p>
        )}
      </div>
    </div>
  );
}