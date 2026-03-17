interface StepDettagliProps {
  type: "prenota" | "richiedi";
  onNext: () => void;
  localitaOrigine: string;
  localitaDestinazione: string;
  datetime: string;
  posti: number;
  prezzo: number;
}

export default function StepDettagli({
  type,
  onNext,
  localitaOrigine,
  localitaDestinazione,
  datetime,
  posti,
  prezzo,
}: StepDettagliProps) {
  const d = new Date(datetime);
  const formattedDate = d.toLocaleDateString("it-IT", { weekday: "short", day: "numeric", month: "short" });
  const formattedTime = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold">
        {type === "prenota" ? "Dettagli prenotazione" : "Dettagli richiesta"}
      </h2>

      <div className="rounded-lg border p-4 space-y-2">
        <div>📍 Da: {localitaOrigine || "N/D"}</div>
        <div>📍 A: {localitaDestinazione || "N/D"}</div>
        <div>📅 {formattedDate} · {formattedTime}</div>
        <div>👤 {posti} {posti === 1 ? "posto" : "posti"}</div>
        <div className="font-semibold">💶 {prezzo.toFixed(2)} €</div>
      </div>

      <button
        onClick={onNext}
        className="w-full bg-[#ff3036] text-white py-3 rounded-lg font-semibold"
      >
        {type === "prenota" ? "Continua" : "Invia richiesta"}
      </button>
    </div>
  );
}
