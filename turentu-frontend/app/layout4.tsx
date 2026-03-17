'use client';

import './globals.css';
import Header from '../components/Header';
import Topbar from '../components/Topbar';
import { UserProvider, useUser } from '../context/UserContext';
import { NotificationProvider, useNotifications } from '../context/NotificationContext';
import { SocketProvider } from '../context/SocketProvider';
import { FaTimes } from 'react-icons/fa';
import { motion, AnimatePresence } from 'framer-motion';
import LoginForm from '../components/LoginForm';
import RegisterForm from '../components/RegisterForm';
import GoogleMapsLoader from './GoogleMapsLoader';
import { useEffect } from 'react';

// ----------------------- POPUP AUTH -----------------------
function GlobalAuthPopup() {
  const { authPopupOpen, setAuthPopupOpen, authMode } = useUser();

  return (
    <AnimatePresence>
      {authPopupOpen && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => setAuthPopupOpen(false)}
          />
          <motion.div
            className="relative bg-white p-6 w-full max-w-md z-10 shadow-xl"
            initial={{ opacity: 0, y: -20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -20, scale: 0.95 }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => setAuthPopupOpen(false)}
              className="absolute top-2 right-2 text-gray-500 hover:text-gray-700"
            >
              <FaTimes />
            </button>

            {authMode === 'login' ? (
              <LoginForm onSuccess={() => setAuthPopupOpen(false)} />
            ) : (
              <RegisterForm onSuccess={() => setAuthPopupOpen(false)} />
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ----------------------- REFRESH NOTIFICATIONS -----------------------
function NotificationRefresher() {
  const { user } = useUser();
  const { refreshNotifications } = useNotifications();

  useEffect(() => {
    if (user?.id) refreshNotifications();
  }, [user?.id, refreshNotifications]);

  return null;
}

// ----------------------- CONTENUTO LAYOUT -----------------------
function LayoutContent({ children }: { children: React.ReactNode }) {
  const { user } = useUser();

  return (
    <>
      <Header />
      {user?.role && <Topbar role={user.role} />}
      <main
        className="flex-1 w-full mt-[74px]" // margine top = Header (42px) + Topbar (~32px)
      >
        <div className="max-w-[960px] w-full mx-auto px-4 sm:px-6 md:px-8">
          {children}
        </div>
      </main>
      <footer className="bg-white p-3 text-center text-sm text-gray-500">
        © 2026 TURENTU
      </footer>
    </>
  );
}

// ----------------------- ROOT LAYOUT -----------------------
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="it">
      <body className="bg-gray-100">
        <UserProvider>
          <SocketProvider>
            <NotificationProvider>
              <GoogleMapsLoader />
              <NotificationRefresher />

              <div className="min-h-screen flex flex-col">
                <LayoutContent>{children}</LayoutContent>
                <GlobalAuthPopup />
              </div>
            </NotificationProvider>
          </SocketProvider>
        </UserProvider>
      </body>
    </html>
  );
}