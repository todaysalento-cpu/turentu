'use client';

import { useState } from 'react';
import { useUser } from '../context/UserContext';
import { useRouter } from 'next/navigation';

type Props = {
  onSuccess?: () => void; // callback da chiamare quando registrazione ok
};

export default function RegisterForm({ onSuccess }: Props) {
  const [email, setEmail] = useState('');
  const [nome, setNome] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const router = useRouter();
  const { login } = useUser();

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    try {
      const res = await fetch('http://localhost:3001/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, nome, password }),
        credentials: 'include',
      });

      if (!res.ok) {
        const text = await res.text();
        setError(text || 'Errore server');
        return;
      }

      const data = await res.json();

      // Aggiorna il contesto globale
      login({
        id: data.id,
        role: data.role,
        email: data.email,
        nome: data.nome,
      });

      if (onSuccess) onSuccess();
      router.push(data.role === 'cliente' ? '/cliente/prenotazioni' : '/autista/corse');

    } catch (err) {
      console.error('❌ Register error:', err);
      setError('Errore server');
    }
  };

  return (
    <form onSubmit={handleRegister} className="flex flex-col gap-3 w-full">
      <h2 className="text-xl font-bold text-center">Registrati</h2>
      {error && <p className="text-red-600 text-center">{error}</p>}

      <input
        type="text"
        placeholder="Nome"
        value={nome}
        onChange={e => setNome(e.target.value)}
        className="border p-2 rounded w-full"
        required
      />
      <input
        type="email"
        placeholder="Email"
        value={email}
        onChange={e => setEmail(e.target.value)}
        className="border p-2 rounded w-full"
        required
      />
      <input
        type="password"
        placeholder="Password"
        value={password}
        onChange={e => setPassword(e.target.value)}
        className="border p-2 rounded w-full"
        required
      />

      <button
        type="submit"
        className="bg-green-600 text-white py-2 rounded hover:bg-green-700 transition"
      >
        Registrati
      </button>
    </form>
  );
}
