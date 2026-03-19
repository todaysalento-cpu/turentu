'use client';

import { useEffect, useState } from 'react';

interface Pagamento {
  id: number;
  cliente: string;
  corsa_id: number;
  prezzo_totale: number;
  commissione: number;
  guadagno_autista: number;
  stato_pagamento: string;
  autista?: string; // opzionale se vuoi mostrare il nome dell'autista
}

interface PagamentiData {
  totale: number;
  commissioni: number;
  bloccati: number;
  pagamenti: Pagamento[];
}

export default function AdminPagamenti() {
  const [data, setData] = useState<PagamentiData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('http://localhost:3001/admin/pagamenti', { credentials: 'include' })
      .then(res => {
        if (!res.ok) throw new Error('Errore API');
        return res.json();
      })
      .then(setData)
      .catch(() => setError('Errore caricamento pagamenti'))
      .finally(() => setLoading(false));
  }, []);

  const rilasciaPagamento = async (id: number) => {
    await fetch(`http://localhost:3001/admin/pagamenti/${id}/rilascia`, {
      method: 'POST',
      credentials: 'include',
    });

    setData(prev =>
      prev
        ? {
            ...prev,
            pagamenti: prev.pagamenti.map(p =>
              p.id === id ? { ...p, stato_pagamento: 'rilasciato' } : p
            ),
          }
        : prev
    );
  };

  const rimborsoWallet = async (id: number) => {
    await fetch(`http://localhost:3001/admin/pagamenti/${id}/rimborso`, {
      method: 'POST',
      credentials: 'include',
    });

    setData(prev =>
      prev
        ? {
            ...prev,
            pagamenti: prev.pagamenti.map(p =>
              p.id === id ? { ...p, stato_pagamento: 'rimborsato' } : p
            ),
          }
        : prev
    );
  };

  if (loading) return <p>Caricamento pagamenti...</p>;
  if (error) return <p className="text-red-500">{error}</p>;

  const pagamenti = data?.pagamenti || [];

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Pagamenti</h1>

      {/* KPI */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-white p-4 rounded shadow">
          <p className="text-gray-500">Totale Incassato</p>
          <p className="text-2xl font-bold">€{data?.totale.toFixed(2)}</p>
        </div>

        <div className="bg-white p-4 rounded shadow">
          <p className="text-gray-500">Commissioni</p>
          <p className="text-2xl font-bold">€{data?.commissioni.toFixed(2)}</p>
        </div>

        <div className="bg-white p-4 rounded shadow">
          <p className="text-gray-500">Fondi Bloccati</p>
          <p className="text-2xl font-bold">€{data?.bloccati.toFixed(2)}</p>
        </div>
      </div>

      {/* Tabella */}
      <table className="w-full bg-white rounded shadow text-sm">
        <thead>
          <tr className="border-b text-left">
            <th className="p-2">ID</th>
            <th className="p-2">Cliente</th>
            <th className="p-2">Corsa</th>
            <th className="p-2">Prezzo</th>
            <th className="p-2">Commissione</th>
            <th className="p-2">Autista</th>
            <th className="p-2">Stato</th>
            <th className="p-2">Azioni</th>
          </tr>
        </thead>

        <tbody>
          {pagamenti.map((p: Pagamento) => (
            <tr key={p.id} className="border-b">
              <td className="p-2">{p.id}</td>
              <td className="p-2">{p.cliente}</td>
              <td className="p-2">#{p.corsa_id}</td>
              <td className="p-2">€{p.prezzo_totale}</td>
              <td className="p-2">{p.commissione ? `€${p.commissione}` : '-'}</td>
              <td className="p-2">{p.guadagno_autista ? `€${p.guadagno_autista}` : '-'}</td>
              <td className="p-2">
                {p.stato_pagamento === 'bloccato' && <span className="text-yellow-600 font-semibold">Bloccato</span>}
                {p.stato_pagamento === 'rilasciato' && <span className="text-green-600 font-semibold">Rilasciato</span>}
                {p.stato_pagamento === 'rimborsato' && <span className="text-red-600 font-semibold">Rimborsato</span>}
              </td>
              <td className="p-2 space-x-2">
                {p.stato_pagamento === 'bloccato' && (
                  <>
                    <button
                      onClick={() => rilasciaPagamento(p.id)}
                      className="bg-green-500 text-white px-2 py-1 rounded"
                    >
                      Rilascia
                    </button>
                    <button
                      onClick={() => rimborsoWallet(p.id)}
                      className="bg-red-500 text-white px-2 py-1 rounded"
                    >
                      Rimborso
                    </button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}