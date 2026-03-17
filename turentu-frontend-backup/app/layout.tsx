'use client';
import './globals.css';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="it">
      <body className="bg-blue-600 text-white min-h-screen flex items-center justify-center">
        {children}
      </body>
    </html>
  );
}
