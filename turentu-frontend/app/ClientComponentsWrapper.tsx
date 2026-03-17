// ClientComponentsWrapper.tsx
'use client';

import Header from './Header';
import GoogleMapsLoader from './GoogleMapsLoader';

export default function ClientComponentsWrapper({ children }: { children: React.ReactNode }) {
  return (
    <>
      <GoogleMapsLoader />
      <Header />
      <main className="flex-1 w-full flex justify-center mt-[60px] p-4 overflow-y-auto">
        <div className="w-full max-w-[1280px] flex flex-col gap-4">{children}</div>
      </main>
      <footer className="bg-white shadow p-2 text-center text-sm text-gray-500">
        © 2026 TURENTU
      </footer>
    </>
  );
}
