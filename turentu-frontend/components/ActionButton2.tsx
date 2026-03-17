import { FiltroSlot } from "../RicercaPage";

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
        fixed bottom-4 left-4 right-4
        bg-[#ff3036] text-white
        py-3 px-6
        rounded-lg font-semibold
        shadow-lg
        hover:bg-[#e02a2f]
        transition-colors
        md:static md:w-full
      "
      onClick={() => onAction(selectedIds)}
    >
      {label}
    </button>
  );
}
