// components/LoginForm.tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useUser } from '../context/UserContext';

type LoginFormProps = {
  onSuccess?: () => void;
};

export default function LoginForm({ onSuccess }: LoginFormProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [resetMode, setResetMode] = useState(false);
  const [successMsg, setSuccessMsg] = useState('');

  const router = useRouter();
  const { login } = useUser();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccessMsg('');
    setLoading(true);

    try {
      if (resetMode) {
        // 🔹 Recupero password
        const res = await fetch('http://localhost:3001/auth/forgot-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        });

        if (!res.ok) {
          const errMsg = (await res.json())?.message || 'Errore invio email';
          setError(errMsg);
        } else {
          setSuccessMsg('📩 Email di recupero inviata con successo!');
        }

      } else {
        // 🔹 Login
        const res = await fetch('http://localhost:3001/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ email, password }),
        });

        if (!res.ok) {
          const errMsg = (await res.json())?.message || 'Credenziali errate o server non disponibile';
          setError(errMsg);
          return;
        }

        const data = await res.json();

        login({
          id: data.id,
          role: data.role,
          email: data.email,
          nome: data.nome,
        });

        if (onSuccess) onSuccess();
        else {
          if (data.role === 'cliente') router.push('/cliente/prenotazioni');
          else if (data.role === 'autista') router.push('/autista/corse');
          else router.push('/admin/dashboard');
        }
      }
    } catch (err) {
      console.error('❌ Error:', err);
      setError('Errore server');
    } finally {
      setLoading(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-white p-6 rounded-lg shadow-md w-full max-w-md flex flex-col gap-4"
    >
      <h1 className="text-2xl font-bold text-center">
        {resetMode ? 'Recupera Password' : 'Login'}
      </h1>

      {error && <p className="text-red-600 text-center">{error}</p>}
      {successMsg && <p className="text-green-600 text-center">{successMsg}</p>}

      <div className="flex flex-col gap-1">
        <label className="font-medium text-sm">Email</label>
        <input
          type="email"
          value={email}
          onChange={e => setEmail(e.target.value)}
          required
          className="border p-2 rounded"
        />
      </div>

      {!resetMode && (
        <div className="flex flex-col gap-1">
          <label className="font-medium text-sm">Password</label>
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
            className="border p-2 rounded"
          />
        </div>
      )}

      <button
        type="submit"
        disabled={loading}
        className={`w-full p-2 rounded text-white font-semibold ${
          loading ? 'bg-gray-400 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-700'
        }`}
      >
        {loading ? '⏳ Elaborazione...' : resetMode ? 'Invia Email' : 'Accedi'}
      </button>

      <p className="text-sm text-center mt-2">
        <button
          type="button"
          className="text-blue-600 hover:underline"
          onClick={() => {
            setResetMode(!resetMode);
            setError('');
            setSuccessMsg('');
          }}
        >
          {resetMode ? '← Torna al login' : '🔑 Hai dimenticato la password?'}
        </button>
      </p>
    </form>
  );
}