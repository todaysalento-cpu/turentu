import { useState } from "react";

interface Props {
  type: "prenota" | "richiedi";
  prezzo: number;
  onNext: () => void;
  onBack: () => void;
}

export default function StepConferma({ type, prezzo, onNext, onBack }: Props) {
  const [ok, setOk] = useState(false);

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold">
        {type === "prenota" ? "Conferma prenotazione" : "Conferma richiesta"}
      </h2>

      <div className="bg-gray-100 p-4 rounded-lg text-sm">
        🔒 <strong>Pagamento solo autorizzato</strong>
        <br />
        {type === "prenota"
          ? "L'importo viene bloccato per riservare il posto."
          : "L'importo viene bloccato finché il conducente risponde."}
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={ok} onChange={() => setOk(!ok)} />
        Ho capito che il pagamento non verrà addebitato ora
      </label>

      <div className="flex gap-3">
        <button onClick={onBack} className="flex-1 border py-3 rounded-lg">
          Indietro
        </button>

        <button
          disabled={!ok}
          onClick={onNext}
          className="flex-1 bg-[#ff3036] text-white py-3 rounded-lg font-semibold disabled:opacity-40"
        >
          Continua al pagamento
        </button>
      </div>
    </div>
  );
}
