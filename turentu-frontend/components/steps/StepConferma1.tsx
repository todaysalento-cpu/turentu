'use client';

interface Props {
  type: "prenota" | "richiedi";
  prezzo: number;
  onNext: () => void;
  onBack: () => void;
}

export default function StepConferma({ type, prezzo, onNext, onBack }: Props) {
  return (
    <div className="flex flex-col h-full justify-center items-center p-4 text-center">
      <h2 className="text-xl font-bold mb-4">{type === "prenota" ? "Conferma Prenotazione" : "Conferma Richiesta"}</h2>
      <p className="text-gray-500 mb-2">Importo stimato:</p>
      <div className="text-3xl font-bold mb-6">{prezzo.toFixed(2)} €</div>

      <div className="flex gap-4">
        <button
          onClick={onBack}
          className="px-4 py-2 border border-gray-300 rounded-lg"
        >
          Indietro
        </button>

        <button
          onClick={onNext}
          className="px-6 py-2 bg-[#ff3036] text-white rounded-lg font-semibold"
        >
          Avanti
        </button>
      </div>
    </div>
  );
}
