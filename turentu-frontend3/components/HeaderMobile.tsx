'use client';

import { FaArrowLeft } from "react-icons/fa"; // ← importa qui
import Tabs from "./Tabs";
import { FiltroSlot } from "../RicercaPage";

interface HeaderMobileProps {
  filtroSlot: FiltroSlot;
  setFiltroSlot: (f: FiltroSlot) => void;
  hideTabs?: boolean;        // true durante BookingFlow
  onEditSearch?: () => void; // solo quando hideTabs=false
}


export default function HeaderMobile({
  filtroSlot,
  setFiltroSlot,
  onEditSearch,
  hideTabs = false,
}: HeaderMobileProps) {
  if (hideTabs) return null; // nasconde tutto se il flusso è aperto

  return (
    <div className="fixed top-0 left-0 w-full z-50 bg-white border-b border-gray-200 flex items-center justify-between h-16 px-4">
      <button onClick={onEditSearch} className="text-2xl text-gray-700">
        <FaArrowLeft />
      </button>
      <div className="flex gap-4 mx-auto overflow-x-auto">
        <Tabs filtri={["Liberi", "Prenotabili"]} selected={filtroSlot} onSelect={setFiltroSlot} />
      </div>
      <div className="w-8" />
    </div>
  );
}
