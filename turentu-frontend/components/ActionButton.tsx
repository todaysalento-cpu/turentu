'use client';

import { FiltroSlot } from "../app/page";

interface ActionButtonProps {
  filtroSlot: FiltroSlot;
  selectedIds: string[];
  onAction: (ids: string[]) => void;
}

export default function ActionButton({ filtroSlot, selectedIds, onAction }: ActionButtonProps) {
  if (selectedIds.length === 0) return null;

  const label = filtroSlot === "Liberi" ? `Richiedi (${selectedIds.length})` : "Prenota";

  return (
    <button
      className="
        w-full
        bg-[#ff3036] text-white
        py-3 px-6
        rounded-lg font-semibold
        shadow-lg
        hover:bg-[#e02a2f]
        transition-colors
      "
      onClick={() => onAction(selectedIds)}
    >
      {label}
    </button>
  );
}