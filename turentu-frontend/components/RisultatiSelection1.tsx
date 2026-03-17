'use client';

import RisultatiList from "./RisultatiList";
import ActionButton from "./ActionButton";
import Tabs from "./Tabs";
import { FiltroSlot } from "../app/page";
import { FaArrowLeft } from 'react-icons/fa';

interface RisultatiSelectionProps {
  risultati: any[];
  filtroSlot: FiltroSlot;
  setFiltroSlot: (f: FiltroSlot) => void;
  selectedIds: string[];
  onSelect: (id: string) => void;
  onAction: (ids: string[]) => void;
  isMobile: boolean;
  onBack?: () => void; // Callback freccia back su mobile
}

export default function RisultatiSelection({
  risultati,
  filtroSlot,
  setFiltroSlot,
  selectedIds,
  onSelect,
  onAction,
  isMobile,
  onBack
}: RisultatiSelectionProps) {

  if (risultati.length === 0) {
    return <p className="text-center text-zinc-500 py-4">Nessun risultato trovato</p>;
  }

  // Mappa filtri per mostrare i nomi personalizzati
  const filtriDisplay = [
    { key: "Liberi", label: "Da solo" },
    { key: "Prenotabili", label: "Insieme" }
  ];

  return (
<div
  className={
    isMobile
      ? "overflow-y-auto px-2 sm:px-3 pb-24 box-border"
      : "flex flex-col gap-4 max-w-[1280px] mx-auto p-4 box-border"
  }
>
  {/* BARRA FILTRI + FRECCIA BACK SU MOBILE */}
  {isMobile && (
    <div className="flex items-center gap-2 mb-2">
      {onBack && (
        <button
          onClick={onBack}
          className="p-2 text-gray-700 hover:text-gray-900"
        >
          <FaArrowLeft size={20} />
        </button>
      )}

      <Tabs
        filtri={filtriDisplay.map(f => f.label)}
        selected={filtriDisplay.find(f => f.key === filtroSlot)?.label || ""}
        onSelect={(label) => {
          const selectedKey = filtriDisplay.find(f => f.label === label)?.key;
          if (selectedKey) setFiltroSlot(selectedKey as FiltroSlot);
        }}
      />
    </div>
  )}

  {/* Lista risultati */}
  <RisultatiList
    risultati={risultati}
    filtroSlot={filtroSlot}
    selectedIds={selectedIds}
    onSelect={onSelect}
  />

  {/* Action button */}
  {selectedIds.length > 0 && (
    <div className={`fixed bottom-0 left-0 w-full px-4 py-4 bg-white z-50 ${isMobile ? "" : "bottom-4"}`}>
      <ActionButton
        filtroSlot={filtroSlot}
        selectedIds={selectedIds}
        onAction={onAction}
      />
    </div>
  )}
</div>

  );
}
