'use client';

import { createContext, useContext, useState, ReactNode, useEffect } from 'react';

type User = {
  id: number | null;
  role: 'cliente' | 'autista' | 'admin' | null;
  email?: string;
  nome?: string;
  guest?: boolean; // true se guest
};

type UserContextType = {
  user: User | null;
  login: (u: User) => void;
  logout: () => Promise<void>;
  loading: boolean;

  // Popup globale auth
  authPopupOpen: boolean;
  setAuthPopupOpen: (v: boolean) => void;
  authMode: 'login' | 'register';
  setAuthMode: (mode: 'login' | 'register') => void;
};

const UserContext = createContext<UserContextType | undefined>(undefined);

export const UserProvider = ({ children }: { children: ReactNode }) => {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  // Stato popup globale
  const [authPopupOpen, setAuthPopupOpen] = useState(false);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');

  // Recupero automatico utente al mount
  useEffect(() => {
    const fetchUser = async () => {
      try {
        const res = await fetch('http://localhost:3001/auth/me', { credentials: 'include' });
        if (!res.ok) {
          setUser({ id: null, role: null, nome: 'Guest', guest: true });
          return;
        }
        const data = await res.json();
        setUser({ ...data, guest: false });
      } catch {
        setUser({ id: null, role: null, nome: 'Guest', guest: true });
      } finally {
        setLoading(false);
      }
    };
    fetchUser();
  }, []);

  const login = (u: User) => {
    setUser({ ...u, guest: false });
    setAuthPopupOpen(false); // chiude il popup al login
  };

  const logout = async () => {
    try {
      await fetch('http://localhost:3001/auth/logout', {
        method: 'POST',
        credentials: 'include',
      });
    } catch (err) {
      console.error('Logout backend error:', err);
    } finally {
      setUser({ id: null, role: null, nome: 'Guest', guest: true });
    }
  };

  return (
    <UserContext.Provider
      value={{
        user,
        login,
        logout,
        loading,
        authPopupOpen,
        setAuthPopupOpen,
        authMode,
        setAuthMode,
      }}
    >
      {children}
    </UserContext.Provider>
  );
};

export const useUser = () => {
  const ctx = useContext(UserContext);
  if (!ctx) throw new Error('useUser deve essere usato dentro UserProvider');
  return ctx;
};
