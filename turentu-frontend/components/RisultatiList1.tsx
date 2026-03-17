import { useState } from "react";
import { FaWifi, FaCar } from "react-icons/fa";
import { MdAcUnit, MdAccessTime } from "react-icons/md";
import { Risultato } from "../types"; // importa i tipi corretti

interface Props {
  risultati?: Risultato[] | null;
  selectedIds?: string[];
  onSelect?: (id: string, multi?: boolean) => void;
  multiSelect?: boolean;
}

export default function RisultatiSlot({
  risultati,
  selectedIds = [],
  onSelect,
  multiSelect = false
}: Props) {
  const items = Array.isArray(risultati) ? risultati : [];

  if (items.length === 0) {
    return <div className="text-sm text-zinc-500 dark:text-zinc-400">Nessun risultato trovato</div>;
  }

  return (
    <div className="flex flex-col gap-3">
      {items.map((r) => {
        const isSelected = selectedIds.includes(r.id);
        const borderColor = isSelected ? "border-[#ff3036]" : "border-gray-300";

        const durataMin = Math.max(0, Math.ceil((r.durataMs ?? 0) / 60000));
        const ore = Math.floor(durataMin / 60);
        const minuti = durataMin % 60;
        const durataStr = ore > 0 ? `${ore}h ${minuti}m` : `${minuti}m`;

        const serviziArray = Array.isArray(r.servizi) ? r.servizi : [];

        const handleClick = () => {
          if (!onSelect) return;
          onSelect(r.id, multiSelect);
        };

        return (
          <div
            key={r.id}
            className={`rounded-xl shadow-sm hover:shadow-md transition p-2.5 border-2 ${borderColor} bg-white cursor-pointer`}
            onClick={handleClick}
          >
            {/* Riga principale */}
            <div className="flex justify-between items-start mb-1">
              <div className="grid grid-cols-[auto_auto_auto] items-center gap-x-1.5">
                <span className="font-bold text-sm">
                  {new Date(r.oraPartenza).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </span>
                <span className="text-zinc-400 text-center">→</span>
                <span className="font-bold text-sm">
                  {new Date(r.oraArrivo).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </span>

                <span className="font-bold text-sm">
                  {r.localitaOrigine ?? "Località sconosciuta"}
                </span>
                <span></span>
                <span className="font-bold text-sm">
                  {r.localitaDestinazione ?? "Località sconosciuta"}
                </span>

                <span className="flex items-center gap-0.5 text-xs text-zinc-500 col-span-3">
                  <MdAccessTime className="w-3 h-3" />
                  {durataStr}
                </span>
              </div>

              <div className="font-bold text-lg ml-4 text-[#ff3036]">
                {(r.prezzo ?? 0).toFixed(2)} €
              </div>
            </div>

            {/* Modello + servizi */}
            <div className="flex flex-wrap items-center gap-1 mt-1 text-xs">
              <span className="font-medium pr-2 border-r border-gray-300 flex items-center gap-1">
                <FaCar className="text-[#ff3036]" />
                {r.modello ?? "N/D"}
              </span>

              {serviziArray.length > 0 && (
                <div className="flex flex-wrap gap-x-1 gap-y-0.5 pl-2">
                  {serviziArray.map((s: string, i: number) => (
                    <span
                      key={i}
                      className="flex items-center gap-0.5 text-[10px] text-zinc-700"
                      title={s}
                    >
                      {s}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
