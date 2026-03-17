'use client';
import { useUser } from '@/context/UserContext';
import Topbar from '@/components/Topbar';

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const { user } = useUser();

  if (!user) return null; // oppure un loader se vuoi

  return (
    <div className="flex flex-col min-h-screen bg-gray-100">
      {/* Topbar */}
      <Topbar role="admin" />

      {/* Contenuto principale */}
      <main className="flex-1 overflow-auto p-6 mt-[42px]">
        {children}
      </main>
    </div>
  );
}