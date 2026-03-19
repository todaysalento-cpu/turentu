import { Risultato } from "../RicercaPage";

interface RisultatoItemProps {
  risultato: Risultato;
  selected: boolean;
  onSelect: () => void;
}

export default function RisultatoItem({ risultato, selected, onSelect }: RisultatoItemProps) {
  return (
    <div
      onClick={onSelect}
      className={`border rounded p-3 mb-2 cursor-pointer transition 
        ${selected ? "border-[#ff3036] bg-red-50" : "border-gray-200 hover:bg-gray-50"}`}
    >
      <div className="flex justify-between">
        <div>
          <div className="font-semibold">{risultato.localitaOrigine} → {risultato.localitaDestinazione}</div>
          <div className="text-sm text-gray-500">{risultato.oraPartenza} - {risultato.oraArrivo}</div>
        </div>
        {risultato.prezzo && <div className="font-semibold">{risultato.prezzo} €</div>}
      </div>
    </div>
  );
}
