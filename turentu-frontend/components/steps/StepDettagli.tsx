'use client';

interface Props {
  type: 'prenota' | 'richiedi';
  risultatiSelezionati?: any[];
  localitaOrigine: string;
  localitaDestinazione: string;
  datetime: string;
  posti: number;
  onRemoveSlot?: (id: string) => void; // 🔹 funzione per rimuovere slot
}

export default function StepDettagli({
  type,
  risultatiSelezionati = [],
  localitaOrigine,
  localitaDestinazione,
  datetime,
  posti,
  onRemoveSlot
}: Props) {
  return (
    <div className="flex flex-col gap-4 p-4">
      <h2 className="text-xl font-bold mb-2">
        {type === 'prenota' ? 'Dettagli Prenotazione' : 'Richiesta'}
      </h2>

      {/* Richiesta in alto */}
      <div className="flex flex-col gap-1 text-sm">
        <div>
          <span className="font-semibold">Da:</span> {localitaOrigine}
        </div>
        <div>
          <span className="font-semibold">A:</span> {localitaDestinazione}
        </div>
        <div>
          <span className="font-semibold">Data e ora:</span>{" "}
          {new Date(datetime).toLocaleString("it-IT", {
            weekday: "short",
            day: "numeric",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
          })}
        </div>
        <div>
          <span className="font-semibold">Posti richiesti:</span> {posti}
        </div>
      </div>

      {/* Lista slot selezionati */}
      <div className="flex flex-col gap-2 mt-2">
        {risultatiSelezionati.length === 0 ? (
          <div className="text-sm text-zinc-500">Nessuno slot selezionato</div>
        ) : (
          risultatiSelezionati.map((slot) => (
            <div
              key={slot.id}
              className="flex justify-between items-center p-2 border rounded-lg bg-white shadow-sm"
            >
              <div className="flex flex-col text-sm">
                <div>
                  {slot.localitaOrigine} → {slot.localitaDestinazione}
                </div>
                <div className="text-zinc-500 text-xs">
                  {new Date(slot.oraPartenza).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}{" "}
                  -{" "}
                  {new Date(slot.oraArrivo).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </div>
              </div>

              <div className="flex items-center gap-2">
                {/* Prezzo */}
                <div className="font-bold text-[#ff3036]">{slot.prezzo?.toFixed(2)} €</div>

                {/* Bottone rimuovi */}
                {onRemoveSlot && (
<button
  className="flex items-center justify-center w-5 h-5 rounded-full bg-red-100 hover:bg-red-200 text-red-600 hover:text-red-800 transition-colors duration-150 text-xs"
  onClick={() => onRemoveSlot(slot.id)}
  aria-label="Rimuovi slot"
>
  ✕
</button>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}