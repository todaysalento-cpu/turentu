'use client';

import { useEffect } from 'react';
import { useUser, UserProvider } from './UserContext';

const TestUser = () => {
  const { user, loading, refreshUser } = useUser();

  useEffect(() => {
    console.log('🔎 UserProvider test - stato user:', user);
    console.log('⏳ loading:', loading);
  }, [user, loading]);

  return (
    <div className="p-4">
      <h2 className="font-bold mb-2">Test UserProvider</h2>
      {loading && <p>Caricamento utente...</p>}
      {!loading && (
        <>
          <p>ID: {user?.id ?? 'null'}</p>
          <p>Role: {user?.role ?? 'null'}</p>
          <p>Nome: {user?.nome ?? 'null'}</p>
          <p>Token: {user?.token ?? 'null'}</p>
          <button
            onClick={refreshUser}
            className="mt-2 px-3 py-1 bg-blue-500 text-white rounded"
          >
            Aggiorna utente
          </button>
        </>
      )}
    </div>
  );
};

// Wrapper con UserProvider
export default function TestUserPage() {
  return (
    <UserProvider>
      <TestUser />
    </UserProvider>
  );
}