
// ===== FILE: corse\page.tsx =====

﻿export default function CorsePage() {
  return (
    <div>
      <h1 className="text-2xl font-bold">Le mie corse</h1>
    </div>
  );
}


// ===== FILE: disponibilita\page.tsx =====

﻿'use client';
import { useUser } from '../../../context/UserContext';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

export default function Disponibilita() {
  const { user } = useUser();
  const router = useRouter();
  const [orari, setOrari] = useState<string[]>([]);

  useEffect(() => {
    if (!user || user.role !== 'autista') router.push('/login');
    else {
      // Fetch simulato
      setOrari(['08:00-12:00', '14:00-18:00']);
    }
  }, [user]);

  if (!user || user.role !== 'autista') return null;

  return (
    <div>
      <h1 className="text-xl font-bold mb-4">Orari di disponibilità</h1>
      <ul>
        {orari.map((o, i) => <li key={i}>{o}</li>)}
      </ul>
    </div>
  );
}


// ===== FILE: layout.tsx =====

'use client';
import React from 'react';
import Topbar from '../../components/Topbar';

export default function AutistaLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Topbar role="autista" />
      <main className="bg-gray-100 min-h-screen p-4">{children}</main>
    </>
  );
}


// ===== FILE: pagamenti\page.tsx =====

﻿export default function PagamentiPage() {
  return (
    <div>
      <h1 className="text-2xl font-bold">Pagamenti</h1>
    </div>
  );
}


// ===== FILE: page.tsx =====

﻿export default function AutistaHome() {
  return (
    <div>
      <h1 className="text-2xl font-bold">Dashboard Autista</h1>
      <p className="text-gray-600">Benvenuto nella tua area personale</p>
    </div>
  );
}


// ===== FILE: profilo\page.tsx =====

﻿'use client';

import { useState } from 'react';

export default function ProfiloPage() {
  const [nome, setNome] = useState('');
  const [email, setEmail] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    console.log('Aggiorna profilo', { nome, email });
  };

  return (
    <div className="max-w-md mx-auto">
      <h1 className="text-2xl font-bold mb-4">Profilo</h1>

      <form onSubmit={handleSubmit} className="space-y-4">
        <input
          className="w-full border p-2 rounded"
          placeholder="Nome"
          value={nome}
          onChange={e => setNome(e.target.value)}
        />

        <input
          className="w-full border p-2 rounded"
          placeholder="Email"
          value={email}
          onChange={e => setEmail(e.target.value)}
        />

        <button className="bg-blue-600 text-white p-2 rounded">
          Salva
        </button>
      </form>
    </div>
  );
}


// ===== FILE: veicolo\page.tsx =====

﻿export default function VeicoloPage() {
  return (
    <div>
      <h1 className="text-2xl font-bold">Veicolo</h1>
    </div>
  );
}

