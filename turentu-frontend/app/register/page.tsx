'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useUser } from '../../context/UserContext';

export default function RegisterPage() {
  const [nome, setNome] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConf, setPasswordConf] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const router = useRouter();
  const { login } = useUser();

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (password !== passwordConf) {
      setError('Le password non coincidono');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('http://localhost:3001/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ nome, email, password }),
      });

      if (!res.ok) {
        const text = await res.text();
        setError(`Errore: ${text}`);
        setLoading(false);
        return;
      }

      const data = await res.json();

      // Aggiorna contesto globale
      login({
        id: data.id,
        role: data.role,
        email: data.email,
        nome: data.nome
      });

      // Redirect automatico in base al ruolo
      if (data.role === 'cliente') router.push('/cliente/prenotazioni');
      else if (data.role === 'autista') router.push('/autista/corse');
      else router.push('/admin/dashboard');

    } catch (err) {
      console.error('❌ Register error:', err);
      setError('Errore server');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex items-center justify-center min-h-screen bg-gray-100 p-4">
      <form
        onSubmit={handleRegister}
        className="bg-white p-8 rounded shadow-md w-full max-w-md space-y-4"
      >
        <h1 className="text-2xl font-bold text-center mb-4">Registrati</h1>
        {error && <p className="text-red-600 text-center">{error}</p>}

        <div>
          <label className="block mb-1 font-medium">Nome</label>
          <input
            type="text"
            value={nome}
            onChange={e => setNome(e.target.value)}
            className="w-full border p-2 rounded"
            required
          />
        </div>

        <div>
          <label className="block mb-1 font-medium">Email</label>
          <input
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            className="w-full border p-2 rounded"
            required
          />
        </div>

        <div>
          <label className="block mb-1 font-medium">Password</label>
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            className="w-full border p-2 rounded"
            required
          />
        </div>

        <div>
          <label className="block mb-1 font-medium">Conferma Password</label>
          <input
            type="password"
            value={passwordConf}
            onChange={e => setPasswordConf(e.target.value)}
            className="w-full border p-2 rounded"
            required
          />
        </div>

        <button
          type="submit"
          disabled={loading}
          className={`w-full py-2 rounded text-white font-semibold transition ${
            loading ? 'bg-gray-400 cursor-not-allowed' : 'bg-[#ff3036] hover:bg-[#e52b30]'
          }`}
        >
          {loading ? '⏳ Registrazione...' : 'Registrati'}
        </button>
      </form>
    </div>
  );
}
