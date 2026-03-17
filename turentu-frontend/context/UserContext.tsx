'use client';

import { createContext, useContext, useState, ReactNode, useEffect } from 'react';

export type UserRole = 'cliente' | 'autista' | 'admin' | null;

export type User = {
  id: number | null;
  role: UserRole;
  email?: string;
  nome?: string;
  token?: string;
  guest?: boolean;
};

type UserContextType = {
  user: User | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  loading: boolean;
  authPopupOpen: boolean;
  setAuthPopupOpen: (v: boolean) => void;
  authMode: 'login' | 'register';
  setAuthMode: (mode: 'login' | 'register') => void;
  refreshUser: () => Promise<void>;
};

const UserContext = createContext<UserContextType | undefined>(undefined);

export const UserProvider = ({ children }: { children: ReactNode }) => {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [authPopupOpen, setAuthPopupOpen] = useState(false);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');

  // ===================== REFRESH UTENTE =====================
  const refreshUser = async () => {
    try {
      setLoading(true);

      const res = await fetch('http://localhost:3001/auth/me', {
        credentials: 'include',
      });

      if (!res.ok) {
        setUser(null);
        sessionStorage.removeItem('user');
        return;
      }

      const data = await res.json();

      const userData: User = {
        id: data.id,
        role: data.role,
        email: data.email,
        nome: data.nome,
        token: data.token,
      };

      setUser(userData);
      sessionStorage.setItem('user', JSON.stringify(userData));

    } catch (err) {
      console.error('❌ [UserProvider] refreshUser error:', err);
      setUser(null);
      sessionStorage.removeItem('user');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refreshUser();
  }, []);

  // ===================== LOGIN =====================
  const login = async (email: string, password: string) => {
    try {
      const res = await fetch('http://localhost:3001/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, password }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || 'Login fallito');
      }

      const data = await res.json();

      const userData: User = {
        id: data.id,
        role: data.role,
        email: data.email,
        nome: data.nome,
        token: data.token,
      };

      setUser(userData);
      sessionStorage.setItem('user', JSON.stringify(userData));
      setAuthPopupOpen(false);

    } catch (err: any) {
      console.error('❌ [UserProvider] Login error:', err.message);
      throw err;
    }
  };

  // ===================== LOGOUT =====================
  const logout = async () => {
    try {
      await fetch('http://localhost:3001/auth/logout', {
        method: 'POST',
        credentials: 'include',
      });
    } catch (err) {
      console.error('❌ Logout error:', err);
    }

    setUser(null);
    sessionStorage.removeItem('user');
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
        refreshUser,
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