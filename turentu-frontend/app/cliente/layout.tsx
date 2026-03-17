'use client';
import React from 'react';
import Topbar from '../../components/Topbar';

export default function ClienteLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Topbar role="cliente" />
      <main className="bg-gray-100 min-h-screen p-4">{children}</main>
    </>
  );
}

