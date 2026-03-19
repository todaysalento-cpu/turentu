'use client';

import Link from 'next/link';
import { useUser } from '../context/UserContext';
import { useNotifications } from '../context/NotificationContext';
import { useChat } from '../context/ChatContext';
import { FaCar, FaSignOutAlt, FaBell, FaCommentDots } from 'react-icons/fa';
import { useRouter } from 'next/navigation';
import { useState, useEffect, useRef } from 'react';

export default function Header() {
  const { user, logout, setAuthPopupOpen, setAuthMode } = useUser();
  const { notifications = [], pendingCount = 0, markAsSeen = () => {} } = useNotifications();
  const { openThread, threads, activeThreadId, setActiveThread, markAsRead } = useChat();
  const router = useRouter();

  const [showNotifications, setShowNotifications] = useState(false);
  const notifRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const [dropdownTop, setDropdownTop] = useState(42);

  // Logout
  const handleLogout = async () => {
    try {
      await logout();
      router.replace('/');
      router.refresh();
    } catch (err) {
      console.error('Logout error:', err);
    }
  };

  // Notifiche
  const handleToggleNotifications = () => setShowNotifications(prev => !prev);
  const handleNotificationClick = (id: number) => markAsSeen(id);

  // Calcolo altezza dropdown notifiche
  useEffect(() => {
    const updateTop = () => {
      if (headerRef.current) setDropdownTop(headerRef.current.offsetHeight);
    };
    updateTop();
    window.addEventListener('resize', updateTop);
    return () => window.removeEventListener('resize', updateTop);
  }, []);

  useEffect(() => setShowNotifications(false), [user?.id]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) {
        setShowNotifications(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const sortedNotifications = [...notifications].sort(
    (a, b) => new Date(b.created_at || '').getTime() - new Date(a.created_at || '').getTime()
  );

  const formatTimeAgo = (dateString?: string) => {
    if (!dateString) return '';
    const now = new Date();
    const date = new Date(dateString);
    const diffMs = now.getTime() - date.getTime();
    const minutes = Math.floor(diffMs / (1000 * 60));
    const hours = Math.floor(diffMs / (1000 * 60 * 60));
    const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    if (minutes < 1) return 'Adesso';
    if (minutes < 60) return `${minutes} min`;
    if (hours < 24) return `${hours} h`;
    if (days < 7) return `${days} g`;
    return date.toLocaleDateString('it-IT');
  };

  // Apri chat generale
  const handleOpenGeneralChat = () => {
    openThread({
      id: 0,
      origine: '',
      destinazione: '',
      participants: [],
      messages: [],
      unreadCount: 0,
    });
    setActiveThread(0);        // Imposta il thread attivo
    markAsRead(0, user.role === 'autista' ? 'Autista' : 'Cliente'); // Segna come letti
  };

  return (
    <header
      ref={headerRef}
      className="fixed top-0 left-0 w-full bg-[#ff3036] shadow-sm z-50 h-[42px] flex items-center px-3"
    >
      <div className="w-full max-w-[720px] mx-auto flex items-center justify-between">
        <Link href="/" className="text-xl font-sans font-semibold text-white tracking-[0.02em] block">
          Turentu
        </Link>

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
                href={user.role === 'autista' ? '/autista/corse' : '/cliente/prenotazioni'}
                className="flex items-center gap-1 text-white hover:text-gray-200 rounded px-2 py-1 transition"
              >
                <FaCar className="text-[12px]" />
                <span className="hidden sm:inline">Dashboard</span>
              </Link>

              {/* Pulsante chat generale */}
              <div className="relative">
                <button
                  onClick={handleOpenGeneralChat}
                  className="p-2 text-white hover:text-gray-200 transition rounded"
                  title="Chat"
                >
                  <FaCommentDots />
                  {threads[0]?.unreadCount > 0 && (
                    <span className="absolute -top-1 -right-1 w-4 h-4 text-[10px] font-bold flex items-center justify-center bg-yellow-400 text-red-600 rounded-full">
                      {threads[0].unreadCount}
                    </span>
                  )}
                </button>
              </div>

              {/* Notifiche */}
              <div ref={notifRef} className="relative">
                <button
                  onClick={handleToggleNotifications}
                  className="relative p-2 text-white hover:text-gray-200 transition rounded"
                  title="Notifiche"
                >
                  <FaBell />
                  {pendingCount > 0 && (
                    <span
                      className="absolute -top-1 -right-1
                                 bg-yellow-300 text-[#ff3036]
                                 text-[8px] font-semibold
                                 min-w-[14px] h-[14px] px-[2.5px]
                                 flex items-center justify-center
                                 rounded-full leading-none
                                 border border-[#ff3036]"
                    >
                      {pendingCount}
                    </span>
                  )}
                </button>

                {showNotifications && (
                  <div
                    className="fixed w-72 bg-white border border-gray-200 rounded shadow-lg p-2 z-60"
                    style={{ top: `${dropdownTop}px`, right: 16 }}
                  >
                    <p className="font-semibold text-[15px] mb-3">Notifiche</p>
                    {sortedNotifications.length === 0 ? (
                      <p className="text-xs text-gray-500">Nessuna notifica</p>
                    ) : (
                      <ul className="text-xs max-h-64 overflow-y-auto">
                        {sortedNotifications.map((n) => (
                          <li
                            key={n.id}
                            className={`cursor-pointer flex justify-between items-start hover:bg-gray-50 rounded px-2 py-1 mb-1 transition ${
                              n.seen ? 'text-gray-500' : 'font-medium bg-blue-50'
                            }`}
                            onClick={() => handleNotificationClick(n.id)}
                          >
                            <div className="flex flex-col">
                              <span className="text-xs font-medium">{n.title || n.message}</span>
                              {n.route && <span className="text-[9px] text-gray-500 mt-0.5">{n.route}</span>}
                              {n.departure && <span className="text-[9px] text-gray-500 mt-0.5">{n.departure}</span>}
                              <span className="text-[8px] text-gray-400 mt-0.5">{formatTimeAgo(n.created_at)}</span>
                            </div>
                            {!n.seen && <span className="w-2 h-2 bg-blue-500 rounded-full mt-1"></span>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>

              {/* Logout */}
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