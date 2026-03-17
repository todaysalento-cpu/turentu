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
      className="fixed bottom-4 left-4 right-4 bg-[#ff3036] text-white py-3 rounded shadow-lg md:static md:w-full"
      onClick={() => onAction(selectedIds)}
    >
      {label}
    </button>
  );
}
