'use client';

interface Props {
  type: 'prenota' | 'richiedi';
  localitaOrigine: string;
  localitaDestinazione: string;
  datetime: string;
  posti: number;
  prezzo: number; // prezzo già passato dal parent
}

export default function StepDettagli({
  type,
  localitaOrigine,
  localitaDestinazione,
  datetime,
  posti,
  prezzo,
}: Props) {
  return (
    <div className="flex flex-col gap-4 p-4">
      <h2 className="text-xl font-bold">
        {type === 'prenota' ? 'Dettagli Prenotazione' : 'Dettagli Richiesta'}
      </h2>

      <div className="flex flex-col gap-2">
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

        {/* Prezzo sempre visibile */}
        <div className="mt-2 text-lg font-bold text-[#ff3036]">
          Prezzo: €{prezzo.toFixed(2)}
        </div>
      </div>
    </div>
  );
}
