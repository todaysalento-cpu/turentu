'use client';

import { ReactNode } from "react";
import { FaTimes } from "react-icons/fa";
import { motion, AnimatePresence } from "framer-motion";

interface CardProps {
  children: ReactNode;
  header?: ReactNode;
  footer?: ReactNode;
  className?: string;
  onClose?: () => void;
  onBack?: () => void; // nuova prop per pulsante indietro
  show?: boolean;
}

export default function BookingCard({
  children,
  header,
  footer,
  className = "",
  onClose,
  onBack,
  show = true,
}: CardProps) {
  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ y: "100%", opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: "100%", opacity: 0 }}
          transition={{
            type: "spring",
            damping: 20,
            stiffness: 120,
          }}
          className={`
            relative
            w-full
            max-w-md md:max-w-[85%] md:w-[600px] md:h-[500px]
            mx-auto
            bg-white dark:bg-gray-800
            rounded-t-2xl md:rounded-xl
            flex flex-col
            px-4 py-4
            ${className}
          `}
          style={{
            overflow: "visible",
            boxShadow: "0 -6px 20px rgba(0,0,0,0.12), 0 4px 12px rgba(0,0,0,0.06)",
          }}
        >
          {/* Pulsante X in alto a destra */}
          {onClose && (
            <button
              onClick={onClose}
              className="
                absolute top-3 right-3
                w-6 h-6
                flex items-center justify-center
                text-gray-500 dark:text-gray-300
                bg-white/70 dark:bg-gray-700/70
                hover:bg-white/90 dark:hover:bg-gray-700/90
                rounded-full
                z-50
                transition-colors duration-150
              "
            >
              <FaTimes size={14} />
            </button>
          )}

          {/* Pulsante Indietro in alto a sinistra */}
          {onBack && (
            <button
              onClick={onBack}
              className="
                absolute top-3 left-3
                w-8 h-8
                flex items-center justify-center
                text-[#ff3036] font-bold text-lg
                rounded-full
                hover:bg-[#ffe5e5]
                z-50
                transition-colors duration-150
              "
            >
              ←
            </button>
          )}

          {/* Header */}
          {header && (
            <div className="flex-shrink-0 px-3 py-2">{header}</div>
          )}

          {/* Contenuto scrollabile */}
          <div className="flex-1 overflow-y-auto px-3 py-3">{children}</div>

          {/* Footer */}
          {footer && (
            <div className="flex-shrink-0 px-3 py-2">{footer}</div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}