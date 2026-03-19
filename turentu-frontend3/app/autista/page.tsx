'use client';

import Link from 'next/link';

export default function AutistaDashboard() {
  return (
    <div className="w-full max-w-[720px] mx-auto space-y-4">
      <h1 className="text-2xl font-bold mb-4">Dashboard Autista</h1>
      <p className="text-gray-600">Benvenuto nella tua area personale</p>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-4">
        <Link
          href="/autista/veicolo"
          className="p-4 bg-white rounded shadow text-center hover:bg-gray-50"
        >
          Veicoli
        </Link>

        <Link
          href="/autista/tariffe"
          className="p-4 bg-white rounded shadow text-center hover:bg-gray-50"
        >
          Tariffe
        </Link>

        <Link
          href="/autista/disponibilita"
          className="p-4 bg-white rounded shadow text-center hover:bg-gray-50"
        >
          Disponibilità
        </Link>

        <Link
          href="/autista/corse"
          className="p-4 bg-white rounded shadow text-center hover:bg-gray-50"
        >
          Corse
        </Link>

        <Link
          href="/autista/profilo"
          className="p-4 bg-white rounded shadow text-center hover:bg-gray-50"
        >
          Profilo
        </Link>

        <Link
          href="/autista/pagamenti"
          className="p-4 bg-white rounded shadow text-center hover:bg-gray-50"
        >
          Pagamenti
        </Link>

        {/* Live */}
        <Link
          href="/autista/live"
          className="p-4 bg-white rounded shadow text-center hover:bg-gray-50"
        >
          Live
        </Link>
      </div>
    </div>
  );
}