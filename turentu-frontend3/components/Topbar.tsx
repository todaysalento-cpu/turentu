'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

interface TopbarProps {
  role: 'cliente' | 'autista' | 'admin';
}

const NAV_ITEMS = {
  cliente: [
    { label: 'Dashboard', href: '/cliente' },
    { label: 'Prenotazioni', href: '/cliente/prenotazioni' },
    { label: 'Account', href: '/cliente/account' },
  ],
  autista: [
    { label: 'Live', href: '/autista/live' },
    { label: 'Dashboard', href: '/autista' },
    { label: 'Veicolo', href: '/autista/veicolo' },
    { label: 'Tariffe', href: '/autista/tariffe' },
    { label: 'Disponibilità', href: '/autista/disponibilita' },
    { label: 'Corse', href: '/autista/corse' },
  ],
  admin: [
    { label: 'Dashboard', href: '/admin/dashboard' },
    { label: 'Gestione', href: '/admin/gestione' },
    { label: 'Pagamenti', href: '/admin/pagamenti' },
    { label: 'Report', href: '/admin/report' },
    { label: 'Impostazioni', href: '/admin/impostazioni' },
  ],
};

export default function Topbar({ role }: TopbarProps) {
  const pathname = usePathname();
  const items = NAV_ITEMS[role] || [];

  return (
    <header
      id="topbar"
      className="fixed top-[42px] left-0 right-0 z-50 bg-white border-b border-[#ff3036]"
    >
      <div className="w-full max-w-[720px] mx-auto px-2">
        <nav className="flex gap-2 overflow-x-auto py-1.5 scrollbar-hide">
          {items.map((item) => {
            // Link attivo se pathname è uguale o inizia con l'href
            const isActive = pathname === item.href || pathname.startsWith(item.href + '/');

            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex-shrink-0 px-2 py-0.5 text-[9.5px] font-medium rounded-md transition
                  ${isActive
                    ? 'bg-[#ff3036] text-white'
                    : 'bg-white text-[#ff3036] border border-[#ff3036] hover:bg-[#ffe6e9]'
                  }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}