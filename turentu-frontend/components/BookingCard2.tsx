'use client';

import { ReactNode } from "react";
import { FaTimes } from "react-icons/fa";

interface CardProps {
  children: ReactNode;
  header?: ReactNode;
  footer?: ReactNode;
  className?: string;
  onClose?: () => void; // callback per chiusura
}

export default function BookingCard({ children, header, footer, className = "", onClose }: CardProps) {
  return (
    <div
      className={`
        bg-white rounded-xl shadow border border-gray-200
        w-full max-w-md mx-auto
        flex flex-col
        md:max-w-[85%] md:h-[500px] md:w-[600px]
        overflow-hidden
        px-4  /* padding laterale */
        ${className}
      `}
    >
      {/* Pulsante X in alto a sinistra */}
      {onClose && (
        <button
          onClick={onClose}
          className="absolute top-2 left-2 text-gray-500 hover:text-gray-700 z-50"
        >
          <FaTimes size={18} />
        </button>
      )}

      {/* Header senza padding verticale */}
      {header && (
        <div className="border-b border-gray-200 flex-shrink-0">
          {header}
        </div>
      )}

      {/* Contenuto scrollabile senza padding verticale */}
      <div className="flex-1 overflow-y-auto">
        {children}
      </div>

      {/* Footer senza padding extra */}
      {footer && <div className="flex-shrink-0">{footer}</div>}
    </div>
  );
}