'use client';

import "./globals.css";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="it">
      <body className="bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-gray-100 font-sans min-h-screen">
        <header className="flex items-center justify-between p-4 bg-white dark:bg-zinc-800 shadow">
          <h1 className="text-xl font-bold">Test Layout</h1>
          <nav>
            <a href="/" className="px-3 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 transition">Home</a>
            <a href="/ricerca" className="ml-2 px-3 py-1 rounded bg-green-600 text-white hover:bg-green-700 transition">Ricerca</a>
          </nav>
        </header>

        <main className="p-8">{children}</main>

        <footer className="p-4 text-center text-sm text-gray-500 dark:text-gray-400">
          © 2026 Test Layout
        </footer>
      </body>
    </html>
  );
}
