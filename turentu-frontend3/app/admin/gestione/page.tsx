'use client';
import { useEffect, useState } from 'react';

export default function GestioneUtenti() {
  const [utenti, setUtenti] = useState<any[]>([]);

  useEffect(() => {
    fetch('http://localhost:3001/admin/gestione', {  // backend su 3001
      credentials: 'include'
    })
      .then(res => res.json())
      .then(data => setUtenti(data))
      .catch(err => console.error('Errore fetch utenti:', err));
  }, []);

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Utenti</h1>

      <table className="w-full bg-white rounded shadow">
        <thead>
          <tr className="border-b">
            <th>ID</th>
            <th>Nome</th>
            <th>Email</th>
            <th>Ruolo</th>
          </tr>
        </thead>

        <tbody>
          {utenti.map(u => (
            <tr key={u.id} className="border-b">
              <td>{u.id}</td>
              <td>{u.nome}</td>
              <td>{u.email}</td>
              <td>{u.ruolo}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}