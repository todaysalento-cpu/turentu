'use client';

import { ReactNode } from "react";

interface CardProps {
  children: ReactNode;
  header?: ReactNode;
  footer?: ReactNode;
  className?: string;
}

export default function BookingCard({ children, header, footer, className = "" }: CardProps) {
  return (
    <div
      className={`
        bg-white rounded-xl shadow border border-gray-200
        w-full max-w-md mx-auto md:max-w-[85%]
        flex flex-col
        ${className}
      `}
    >
      {/* Header personalizzato */}
      {header && <div className="p-4 border-b border-gray-200">{header}</div>}

      {/* Contenuto centrale scrollabile */}
      <div className="flex-1 overflow-y-auto p-4">{children}</div>

      {/* Footer */}
      {footer && <div className="p-4 border-t border-gray-200">{footer}</div>}
    </div>
  );
}
