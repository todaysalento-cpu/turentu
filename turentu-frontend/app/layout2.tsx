'use client';

import './globals.css';
import Header from '../components/Header';
import { UserProvider, useUser } from '../context/UserContext';
import { FaTimes } from 'react-icons/fa';
import { motion, AnimatePresence } from 'framer-motion';
import LoginForm from '../components/LoginForm';
import RegisterForm from '../components/RegisterForm';
import GoogleMapsLoader from './GoogleMapsLoader';

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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="it">
      <body className="bg-gray-100">
        <UserProvider>
          <GoogleMapsLoader />

          {/* WRAPPER FLEX QUI, NON SUL BODY */}
          <div className="min-h-screen flex flex-col pt-[48px]">
            
            <Header className="bg-[#ff3036] text-white shadow-md fixed top-0 left-0 right-0 h-[48px] z-50" />

            <GlobalAuthPopup />

            <main className="flex-1">
              <div className="max-w-[960px] mx-auto px-4 sm:px-6 md:px-8 pb-24">
                <div className="bg-white p-6">
                  {children}
                </div>
              </div>
            </main>

            <footer className="bg-white p-3 text-center text-sm text-gray-500">
              © 2026 TURENTU
            </footer>

          </div>
        </UserProvider>
      </body>
    </html>
  );
}