'use client';

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
