'use client';

import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import { useState, useEffect } from "react";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const [loggedIn, setLoggedIn] = useState(false);
  const [username, setUsername] = useState("");

  useEffect(() => {
    const user = localStorage.getItem("turentu_user");
    if (user) {
      setLoggedIn(true);
      setUsername(user);
    }
  }, []);

  const handleAuthClick = () => {
    if (loggedIn) {
      localStorage.removeItem("turentu_user");
      setLoggedIn(false);
      setUsername("");
    } else {
      const name = prompt("Inserisci nome utente") || "User";
      localStorage.setItem("turentu_user", name);
      setUsername(name);
      setLoggedIn(true);
    }
  };

  return (
    <html lang="it">
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        <header className="flex items-center justify-between bg-white dark:bg-zinc-900 shadow-md p-4">
          <Link href="/" className="text-xl font-bold">Turentu</Link>
          <div>
            <button
              onClick={handleAuthClick}
              className="px-3 py-1 bg-red-600 text-white rounded hover:bg-red-700 transition"
            >
              {loggedIn ? `Logout (${username})` : "Accedi"}
            </button>
          </div>
        </header>

        <main className="w-full min-h-[calc(100vh-64px)]">
          {children}
        </main>
      </body>
    </html>
  );
}
