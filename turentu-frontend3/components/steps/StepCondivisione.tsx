interface Props {
  condivisibile: boolean | null;
  setCondivisibile: (v: boolean) => void;
}

export default function StepCondivisione({ condivisibile, setCondivisibile }: Props) {
  return (
    <div className="p-4 flex flex-col gap-6 h-full justify-center text-center">
      <h2 className="text-xl font-semibold">Vuoi condividere la corsa?</h2>
      <p className="text-gray-500 text-sm">
        Se scegli di condividere, altri clienti potranno acquistare posti sulla stessa corsa.
      </p>

      <div className="flex flex-col gap-3 mt-4">
        <button
          onClick={() => setCondivisibile(true)}
          className={`h-12 rounded-lg border font-medium transition-colors ${
            condivisibile === true
              ? "bg-[#ff3036] text-white border-[#ff3036]"
              : "bg-white text-gray-700 border-gray-300 hover:bg-gray-100"
          }`}
        >
          Condividi la corsa
        </button>

        <button
          onClick={() => setCondivisibile(false)}
          className={`h-12 rounded-lg border font-medium transition-colors ${
            condivisibile === false
              ? "bg-[#ff3036] text-white border-[#ff3036]"
              : "bg-white text-gray-700 border-gray-300 hover:bg-gray-100"
          }`}
        >
          Corsa privata
        </button>
      </div>

      <p className="text-gray-400 text-sm mt-6">
        Seleziona un'opzione per continuare.
      </p>
    </div>
  );
}