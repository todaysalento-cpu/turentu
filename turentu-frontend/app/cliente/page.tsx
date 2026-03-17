'use client';

import Link from 'next/link';

export default function ClienteDashboard() {
  return (
    <div className="p-4">
      <h1 className="text-2xl font-bold mb-4">Dashboard Cliente</h1>
      <div className="space-y-2">
        <Link href="/cliente/prenotazioni" className="block p-4 bg-white rounded shadow hover:bg-gray-50">
          Le tue prenotazioni
        </Link>
        <Link href="/cliente/account" className="block p-4 bg-white rounded shadow hover:bg-gray-50">
          Gestione account
        </Link>
      </div>
    </div>
  );
}

