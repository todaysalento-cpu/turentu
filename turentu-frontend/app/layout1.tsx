// app/layout.tsx
import './globals.css';
import Header from './Header';

export const metadata = {
  title: 'TURENTU',
  description: 'Servizio di corse',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="it">
      <body className="bg-gray-100 min-h-screen flex flex-col">
        {/* Header fisso */}
        <Header />

        {/* Main content spinto sotto l'header */}
        <main className="flex-1 w-full flex flex-col items-stretch mt-[60px]">
          {children}
        </main>

        {/* Footer semplice */}
        <footer className="bg-white shadow p-2 text-center text-sm text-gray-500">
          © 2026 TURENTU
        </footer>
      </body>
    </html>
  );
}
