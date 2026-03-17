interface Props {
  type: "prenota" | "richiedi";
  prezzo: number;
  onClose: () => void;
}

export default function StepPagamento({ type, prezzo, onClose }: Props) {
  const handleAuthorize = () => {
    // 👉 QUI: Stripe / pagamento
    onClose();
  };

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold">Autorizza pagamento</h2>

      <div className="text-center">
        <div className="text-gray-500">Importo da autorizzare</div>
        <div className="text-3xl font-bold">{prezzo.toFixed(2)} €</div>
        <div className="text-xs text-gray-400 mt-2">
          Nessun addebito immediato
        </div>
      </div>

      <button
        onClick={handleAuthorize}
        className="w-full bg-[#ff3036] text-white py-3 rounded-lg font-semibold"
      >
        {type === "prenota"
          ? "Autorizza e prenota"
          : "Autorizza e invia richiesta"}
      </button>

      <button
        onClick={onClose}
        className="w-full text-center text-sm text-gray-500"
      >
        Annulla
      </button>
    </div>
  );
}
