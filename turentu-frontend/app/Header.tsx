'use client';
import Link from 'next/link';
import { useUser } from '../context/UserContext';
import { FaUser, FaCar, FaSignOutAlt } from 'react-icons/fa';
import { useRouter } from 'next/navigation';

export default function Header() {
  const { user, logout, setLoginOpen } = useUser();
  const router = useRouter();

  const handleLogout = async () => {
    try {
      await fetch('http://localhost:3001/auth/logout', { method: 'POST', credentials: 'include' });
      logout();
      router.push('/'); // rimane sulla home
    } catch (err) {
      console.error('Logout error:', err);
    }
  };

  return (
    <header className="fixed top-0 left-0 w-full bg-white shadow z-50 h-[60px] flex items-center">
      <div className="w-full max-w-[1280px] mx-auto px-4 flex items-center justify-between">
        <Link href="/" className="text-xl font-bold text-[#ff3036]">TURENTU</Link>

        <nav className="flex items-center gap-4">
          {!user ? (
            <button
              onClick={() => setLoginOpen(true)}
              className="flex items-center gap-1 text-gray-700 hover:text-[#ff3036]"
            >
              <FaUser />
              <span className="hidden sm:inline">Accedi</span>
            </button>
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
                className="flex items-center gap-1 text-gray-700 hover:text-[#ff3036]"
              >
                <FaCar />
                <span className="hidden sm:inline">Dashboard</span>
              </Link>
              <button
                onClick={handleLogout}
                className="flex items-center gap-1 text-red-600 hover:text-red-700"
              >
                <FaSignOutAlt />
                <span className="hidden sm:inline">Logout</span>
              </button>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}
