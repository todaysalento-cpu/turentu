'use client';

import { useState } from 'react';

export default function AccountPage() {
  const [nome, setNome] = useState('');
  const [email, setEmail] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // fetch PUT/POST verso API per aggiornare dati account
    console.log('Aggiorna account:', { nome, email });
  };

  return (
    <div className="p-4 max-w-md mx-auto">
      <h1 className="text-2xl font-bold mb-4">Gestione Account</h1>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block mb-1">Nome</label>
          <input
            className="w-full border p-2 rounded"
            value={nome}
            onChange={e => setNome(e.target.value)}
          />
        </div>
        <div>
          <label className="block mb-1">Email</label>
          <input
            className="w-full border p-2 rounded"
            value={email}
            onChange={e => setEmail(e.target.value)}
          />
        </div>
        <button type="submit" className="bg-blue-600 text-white p-2 rounded hover:bg-blue-700">
          Aggiorna
        </button>
      </form>
    </div>
  );
}
