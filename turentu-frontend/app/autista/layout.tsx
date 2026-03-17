'use client';
import React from 'react';
import Topbar from '../../components/Topbar';

export default function AutistaLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col">

      {/* Topbar */}
      <Topbar role="autista" />

      {/* Main */}
      <main className="flex-1 w-full" style={{ marginTop: '30px' }}>
        <div className="w-full max-w-[720px] mx-auto bg-white min-h-[calc(100vh-50px)] pt-4">
          {children}
        </div>
      </main>

    </div>
  );
}