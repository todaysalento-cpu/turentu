// components/Header.tsx
'use client';

import Link from 'next/link';
import { useUser } from '../context/UserContext';
import { FaCar, FaSignOutAlt } from 'react-icons/fa';
import { useRouter } from 'next/navigation';

export default function Header() {
  const { user, logout, setAuthPopupOpen, setAuthMode } = useUser();
  const router = useRouter();

  const handleLogout = async () => {
    try {
      await logout();
      router.replace('/');
      router.refresh();
    } catch (err) {
      console.error('Logout error:', err);
    }
  };

  return (
    <header className="fixed top-0 left-0 w-full bg-[#ff3036] shadow-sm z-50 h-[42px] flex items-center px-3">
      <div className="w-full max-w-[720px] mx-auto flex items-center justify-between">
        {/* Logo minimal in stile Uber */}
<Link
  href="/"
  className="text-xl font-sans font-semibold text-white tracking-[0.02em] block"
>
  Turentu
</Link>
        {/* Menu compatto */}
        <nav className="flex items-center gap-2 sm:gap-3 text-xs">
          {!user || user.guest ? (
            <>
              <button
                onClick={() => { setAuthMode('login'); setAuthPopupOpen(true); }}
                className="px-2 py-1 text-white hover:text-gray-200 rounded transition"
              >
                Accedi
              </button>

              <button
                onClick={() => { setAuthMode('register'); setAuthPopupOpen(true); }}
                className="px-2 py-1 text-[#ff3036] bg-white hover:bg-gray-100 rounded transition"
              >
                Registrati
              </button>
            </>
          ) : (
            <>
              <Link
                href={
                  user.role === 'autista'
                    ? '/autista/corse'
                    : user.role === 'cliente'
                    ? '/cliente/prenotazioni'
                    : '/admin/dashboard'
                }
                className="flex items-center gap-1 text-white hover:text-gray-200 rounded px-2 py-1 transition"
              >
                <FaCar className="text-[12px]" />
                <span className="hidden sm:inline">Dashboard</span>
              </Link>

              <button
                onClick={handleLogout}
                className="flex items-center gap-1 text-white hover:text-gray-200 rounded px-2 py-1 transition"
              >
                <FaSignOutAlt className="text-[12px]" />
                <span className="hidden sm:inline">Logout</span>
              </button>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}