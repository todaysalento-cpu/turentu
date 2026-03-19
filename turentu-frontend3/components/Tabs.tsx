'use client';

import { FaArrowLeft } from 'react-icons/fa';

interface TabsProps {
  filtri: string[];
  selected: string;
  onSelect: (f: string) => void;
  onBack?: () => void; // callback freccia
}

export default function Tabs({ filtri, selected, onSelect, onBack }: TabsProps) {
  return (
    <div className="flex items-center gap-2 overflow-x-auto py-1 px-2 sticky top-0 z-20">
      
      {/* Freccia indietro compatta */}
      {onBack && (
        <button
          onClick={onBack}
          className="flex-shrink-0 p-1 rounded-full hover:bg-gray-100 active:bg-gray-200 transition-colors"
        >
          <FaArrowLeft size={16} className="text-gray-700" />
        </button>
      )}

      {/* Tab buttons compatte, senza bordo o padding extra */}
      {filtri.map(f => (
        <button
          key={f}
          onClick={() => onSelect(f)}
          className={`flex-shrink-0 px-3 py-1 text-xs rounded-full font-semibold whitespace-nowrap transition-all duration-200
            ${f === selected
              ? "bg-[#ff3036] text-white"
              : "bg-gray-100 text-gray-700 hover:bg-gray-200"
            }`}
        >
          {f}
        </button>
      ))}
    </div>
  );
}