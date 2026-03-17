'use client';

import { useEffect } from "react";
import RisultatiList from "./RisultatiList";
import Tabs from "./Tabs";
import { FiltroSlot } from "../app/page";
import { FaArrowLeft } from 'react-icons/fa';

interface RisultatiSelectionProps {
  risultati: any[];
  filtroSlot: FiltroSlot;
  setFiltroSlot: (f: FiltroSlot) => void;
  selectedIds: string[];
  onSelect: (id: string) => void;
  isMobile: boolean;
  onBack?: () => void;
}

export default function RisultatiSelection({
  risultati,
  filtroSlot,
  setFiltroSlot,
  selectedIds,
  onSelect,
  isMobile,
  onBack
}: RisultatiSelectionProps) {

  useEffect(() => {
    console.log("RisultatiSelection render → filtroSlot:", filtroSlot);
    console.log("Selected IDs:", selectedIds);
    console.log("Numero risultati:", risultati.length);
    console.log("IDs risultati:", risultati.map(r => ({ id: r.id, stato: r.stato })));
  }, [filtroSlot, selectedIds, risultati]);

  if (risultati.length === 0) {
    return <p className="text-center text-zinc-500 py-4">Nessun risultato trovato</p>;
  }

  const filtriDisplay = [
    { key: "Liberi", label: "Da solo" },
    { key: "Prenotabili", label: "Insieme" },
    { key: "Tutte", label: "Tutti" },
  ];

  return (
    <div className="flex flex-col h-full">

      {/* TAB BAR FISSA IN ALTO */}
      {isMobile && (
        <div className="sticky top-0 z-30 bg-white flex justify-center items-center py-1 px-2 border-b border-gray-100">
          {onBack && (
            <button
              onClick={onBack}
              className="absolute left-2 p-1 rounded-full hover:bg-gray-100 active:bg-gray-200"
            >
              <FaArrowLeft size={16} className="text-gray-700" />
            </button>
          )}

          <Tabs
            filtri={filtriDisplay.map(f => f.label)}
            selected={filtriDisplay.find(f => f.key === filtroSlot)?.label || ""}
            onSelect={(label) => {
              const selectedKey = filtriDisplay.find(f => f.label === label)?.key;
              if (selectedKey) setFiltroSlot(selectedKey as FiltroSlot);
            }}
            className="text-xs flex gap-1"
            tabClassName="px-3 py-1 rounded-full hover:bg-gray-100"
            selectedTabClassName="bg-[#ff3036] text-white shadow-md"
          />
        </div>
      )}

      {/* LISTA RISULTATI SCORREVOLE */}
      <div className="flex-1 overflow-y-auto">
        <RisultatiList
          risultati={risultati}
          filtroSlot={filtroSlot}
          selectedIds={selectedIds}
          onSelect={onSelect}
        />
      </div>
    </div>
  );
}