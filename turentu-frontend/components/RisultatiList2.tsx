import { Risultato } from "../types";
import { FaCar } from "react-icons/fa";
import { MdAccessTime } from "react-icons/md";

interface Props {
  risultati?: Risultato[] | null;
  selectedIds?: string[];
  onSelect?: (id: string, multi?: boolean) => void;
  multiSelect?: boolean;
  isMobile?: boolean;
}

export default function RisultatiSlot({
  risultati,
  selectedIds = [],
  onSelect,
  multiSelect = false,
  isMobile = false,
}: Props) {
  const items = Array.isArray(risultati) ? risultati : [];

  if (items.length === 0) {
    return <div className="text-sm text-zinc-500">Nessun risultato trovato</div>;
  }

  return (
    <div className="flex flex-col gap-2">
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
            className={`rounded-xl shadow-sm hover:shadow-md transition p-2 border-2 ${borderColor} bg-white cursor-pointer`}
            onClick={handleClick}
          >
            {/* HEADER: Immagine veicolo a sinistra, info a destra */}
            <div className="flex gap-3 items-center mb-1">
              {/* Immagine veicolo full width */}
              <div className="w-28 sm:w-32 flex-shrink-0 flex justify-center items-center overflow-hidden rounded-md">
                <img
                  src={
                    r.imageUrl ??
                    "https://media.istockphoto.com/id/1186972461/it/foto/generico-auto-bianca-isolata-su-sfondo-bianco.jpg?s=612x612&w=0&k=20&c=Ys-fj9U8zEriVOYRgzIPsKpsC1eKewRdsJtprViM80k="
                  }
                  alt={r.modello ?? "Veicolo"}
                  className="w-full object-contain"
                  loading="lazy"
                />
              </div>

              {/* Info principali */}
              <div className="flex-1 flex flex-col justify-between">
                <div className="flex flex-col gap-0.5">
                  {/* Orari */}
                  <div className="flex items-center gap-1 text-sm font-bold">
                    <span>{new Date(r.oraPartenza).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                    <span className="text-zinc-400">→</span>
                    <span>{new Date(r.oraArrivo).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                  </div>

                  {/* Località */}
                  <div className="flex items-center gap-1 text-sm">
                    <span>{r.localitaOrigine ?? "Località sconosciuta"}</span>
                    <span>→</span>
                    <span>{r.localitaDestinazione ?? "Località sconosciuta"}</span>
                  </div>

                  {/* Durata */}
                  <div className="flex items-center gap-1 text-xs text-zinc-500">
                    <MdAccessTime className="w-3 h-3" />
                    {durataStr}
                  </div>
                </div>
              </div>
            </div>

            {/* MODELLO + SERVIZI + PREZZO (riga separata sotto, allineata orizzontalmente) */}
            <div className="flex justify-between items-center text-xs mt-1 px-1">
              <div className="flex flex-wrap items-center gap-1">
                <span className="font-medium pr-2 border-r border-gray-300 flex items-center gap-1">
                  <FaCar className="text-[#ff3036]" /> {r.modello ?? "N/D"}
                </span>
                {serviziArray.length > 0 &&
                  serviziArray.map((s, i) => (
                    <span key={i} className="text-[10px] text-zinc-700" title={s}>
                      {s}
                    </span>
                  ))}
              </div>

              {/* Prezzo */}
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
