'use client';

import React from "react";

interface Props {
  type: "prenota" | "richiedi";
  prezzo: number;
  onBack: () => void;
  onConfirm: () => void;
  loading: boolean;
}

export default function StepPagamento({ type, prezzo, onBack, onConfirm, loading }: Props) {
  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold">Pagamento</h2>

      <div className="rounded-lg border p-4">
        <div>
          💶 Importo da pagare: <span className="font-bold">{prezzo.toFixed(2)} €</span>
        </div>
        <div className="text-xs text-gray-500 mt-2">
          Non ci sarà addebito fino alla conferma
        </div>
      </div>

      <div className="flex gap-2">
        <button
          onClick={onBack}
          className="flex-1 py-3 bg-gray-200 rounded-lg font-semibold"
        >
          Indietro
        </button>

        <button
          onClick={onConfirm}
          className="flex-1 py-3 bg-[#ff3036] text-white rounded-lg font-semibold"
          disabled={loading}
        >
          {loading ? "Caricamento..." : "Autorizza e paga"}
        </button>
      </div>
    </div>
  );
}
