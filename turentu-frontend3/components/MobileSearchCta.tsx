'use client';

import { motion } from "framer-motion";
import { FaCar } from "react-icons/fa";

interface MobileSearchCTAProps {
  loading?: boolean;
  onClick: () => void;
}

export default function MobileSearchCTA({
  loading = false,
  onClick,
}: MobileSearchCTAProps) {
  return (
    <motion.div
      initial={{ y: 80 }}
      animate={{ y: 0 }}
      transition={{ duration: 0.25, ease: "easeOut" }}
      className="fixed bottom-0 left-0 right-0 z-50 md:hidden"
    >
      {/* Blur + shadow stile Uber */}
      <div className="bg-white/90 backdrop-blur border-t border-gray-200 px-4 py-3 pb-[calc(env(safe-area-inset-bottom)+12px)] shadow-[0_-4px_20px_rgba(0,0,0,0.08)]">
        <button
          onClick={onClick}
          disabled={loading}
          className="w-full h-12 rounded-xl bg-[#ff3036] text-white font-semibold flex items-center justify-center gap-2 active:scale-[0.98] transition"
        >
          <FaCar />
          {loading ? "Cerco..." : "Cerca"}
        </button>
      </div>
    </motion.div>
  );
}
