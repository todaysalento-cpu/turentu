'use client';

import { FaCar } from "react-icons/fa";
import { MdAccessTime } from "react-icons/md";
import { Risultato } from "../types";
import { FiltroSlot } from "../app/page";

interface Props {
  risultati?: Risultato[];
  selectedIds?: string[];
  onSelect?: (id: string, multi?: boolean) => void;
  multiSelect?: boolean;
  filtroSlot?: FiltroSlot; // "Liberi" | "Prenotabili" | "Tutte"
}

export default function RisultatiList({
  risultati = [],
  selectedIds = [],
  onSelect,
  multiSelect = false,
  filtroSlot = "Tutte",
}: Props) {

  if (risultati.length === 0) {
    return <div className="text-sm text-zinc-500">Nessun risultato trovato</div>;
  }

  // 🔹 Mapping frontend → stato
  const filtroMap: Record<FiltroSlot, string> = {
    Liberi: "libero",
    Prenotabili: "prenotabile",
    Tutte: "" // non serve, solo per coerenza
  };

  // ⚡ FILTRO basato direttamente sullo stato dal backend
  const filtrati = risultati.filter(r => {
    if (filtroSlot === "Tutte") return true; // mostra tutti
    return r.stato === filtroMap[filtroSlot]; // usa lo stato dal backend
  });

  if (filtrati.length === 0) {
    return <div className="text-sm text-zinc-500">Nessun risultato corrisponde al filtro</div>;
  }

  return (
    <div className="flex flex-col gap-2">
      {filtrati.map((r) => {
        const isSelected = selectedIds.includes(r.id);
        const borderColor = isSelected ? "border-[#ff3036]" : "border-gray-300";

        const durataMin = Math.max(
          0,
          Math.ceil((r.durataMs ?? (r.durataMinuti ?? 30) * 60000) / 60000)
        );
        const ore = Math.floor(durataMin / 60);
        const minuti = durataMin % 60;
        const durataStr = ore > 0 ? `${ore}h ${minuti}m` : `${minuti}m`;

        const serviziArray = Array.isArray(r.servizi) ? r.servizi : [];

        const handleClick = () => onSelect?.(r.id, multiSelect);

        return (
          <div
            key={r.id}
            className={`rounded-xl shadow-sm hover:shadow-md transition p-2 border-2 ${borderColor} bg-white cursor-pointer`}
            onClick={handleClick}
          >
            {/* HEADER */}
            <div className="flex gap-3 items-center mb-1">
              <div className="w-28 sm:w-32 flex-shrink-0 flex justify-center items-center overflow-hidden rounded-md">
                <img
                  src={r.imageUrl ?? "/images/generico-auto-bianca.jpg"}
                  alt={r.modello ?? "Veicolo"}
                  className="w-full object-contain"
                  loading="lazy"
                />
              </div>
              <div className="flex-1 flex flex-col justify-between">
                <div className="flex flex-col gap-0.5">
                  <div className="flex items-center gap-1 text-sm font-bold">
                    <span>{new Date(r.oraPartenza).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                    <span className="text-zinc-400">→</span>
                    <span>{new Date(r.oraArrivo).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                  </div>
                  <div className="flex items-center gap-1 text-sm">
                    <span>{r.localitaOrigine ?? "Sconosciuta"}</span>
                    <span>→</span>
                    <span>{r.localitaDestinazione ?? "Sconosciuta"}</span>
                  </div>
                  <div className="flex items-center gap-1 text-xs text-zinc-500">
                    <MdAccessTime className="w-3 h-3" />
                    {durataStr}
                  </div>
                </div>
              </div>
            </div>

            {/* MODELLO + SERVIZI + PREZZO */}
            <div className="flex justify-between items-center text-xs mt-1 px-1">
              <div className="flex flex-wrap items-center gap-1">
                <span className="font-medium pr-2 border-r border-gray-300 flex items-center gap-1">
                  <FaCar className="text-[#ff3036]" /> {r.modello ?? "N/D"}
                </span>
                {serviziArray.map((s, i) => (
                  <span key={i} className="text-[10px] text-zinc-700" title={s}>
                    {s}
                  </span>
                ))}
              </div>
              <div className="font-bold text-lg sm:text-xl text-[#ff3036] pr-1">
                {(r.prezzo ?? 0).toFixed(2)} €
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}