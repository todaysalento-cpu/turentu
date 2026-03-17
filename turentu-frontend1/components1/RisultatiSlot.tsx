import { useState } from "react";
import { FaWifi, FaCar } from "react-icons/fa";
import { MdAcUnit, MdAccessTime } from "react-icons/md";

interface Props {
  risultati?: any[] | null; // accetta anche null/undefined
}

export default function RisultatiSlot({ risultati }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Mappa servizi → icone
  const servizioIconMap: Record<string, JSX.Element> = {
    wifi: <FaWifi className="inline mr-0.5" />,
    "aria condizionata": <MdAcUnit className="inline mr-0.5" />,
  };

  // Forzo sempre un array
  const items = Array.isArray(risultati) ? risultati : [];

  if (items.length === 0) {
    return (
      <div className="text-sm text-zinc-500 dark:text-zinc-400">
        Nessun risultato trovato
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {items.map((r) => {
        const isSelected = r.id === selectedId;

        const bgColor = "bg-white dark:bg-white"; 
        const borderColor = isSelected ? "border-[#ff3036]" : "border-gray-300";

        const durataMin = Math.ceil((r.durataMs ?? 0) / 60000);
        const ore = Math.floor(durataMin / 60);
        const minuti = durataMin % 60;
        const durataStr = ore > 0 ? `${ore}h ${minuti}m` : `${minuti}m`;

        return (
          <div
            key={r.id}
            className={`rounded-xl shadow-sm hover:shadow-md transition p-2.5 border-2 ${borderColor} ${bgColor} cursor-pointer`}
            onClick={() => setSelectedId(r.id)}
          >
            {/* Riga principale */}
            <div className="flex justify-between items-start mb-1">
              <div className="grid grid-cols-[auto_auto_auto] items-center gap-x-1.5">
                <span className="font-bold text-sm text-zinc-800 dark:text-zinc-100">
                  {new Date(r.oraPartenza).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </span>
                <span className="text-zinc-400 dark:text-zinc-500 text-center">→</span>
                <span className="font-bold text-sm text-zinc-800 dark:text-zinc-100">
                  {new Date(r.oraArrivo).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </span>

                <span className="font-bold text-sm text-zinc-700 dark:text-zinc-300">
                  {r.localitaOrigine}
                </span>
                <span></span>
                <span className="font-bold text-sm text-zinc-700 dark:text-zinc-300">
                  {r.localitaDestinazione}
                </span>

                <span className="flex items-center gap-0.5 text-xs text-zinc-500 dark:text-zinc-400 col-span-3">
                  <MdAccessTime className="w-3 h-3" />
                  {durataStr}
                </span>
              </div>

              <div className="font-bold text-lg ml-4 flex-shrink-0 leading-none pt-0.5 text-[#ff3036]">
                {r.prezzo?.toFixed(2)} €
              </div>
            </div>

            {/* Modello + servizi */}
            <div className="flex flex-wrap items-center gap-1 mt-1 text-xs">
              <span className="font-medium pr-2 border-r border-gray-300 dark:border-zinc-700 flex items-center gap-1">
                <FaCar className="text-[#ff3036]" />
                {r.modello}
              </span>

              {r.servizi?.length > 0 && (
                <div className="flex flex-wrap gap-x-1 gap-y-0.5 pl-2">
                  {r.servizi.map((s: string, i: number) => (
                    <span
                      key={i}
                      className="flex items-center gap-0.5 text-[10px] text-zinc-700 dark:text-zinc-300"
                      title={s}
                    >
                      {servizioIconMap[s.toLowerCase()] ?? null}
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
