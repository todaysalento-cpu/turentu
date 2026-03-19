interface StepConfermaProps {
  type: "prenota" | "richiedi";
  risultatiSelezionati?: Risultato[];
}

export default function StepConferma({ type, risultatiSelezionati = [] }: StepConfermaProps) {
  const prezzoSingolo = type === "prenota" ? risultatiSelezionati?.[0]?.prezzo ?? 0 : undefined;

  return (
    <div className="flex flex-col h-full justify-center items-center p-4 text-center space-y-4">
      <h2 className="text-xl font-bold">
        {type === "prenota" ? "Conferma Prenotazione" : "Conferma Richiesta"}
      </h2>

      {type === "prenota" && (
        <div>
          <p className="text-gray-500 mb-2">Importo stimato:</p>
          <div className="text-3xl font-bold">{prezzoSingolo?.toFixed(2) ?? "0.00"} €</div>
        </div>
      )}

      {type === "richiedi" && risultatiSelezionati.length > 0 && (
        <div className="text-gray-700">
          Hai selezionato {risultatiSelezionati.length} {risultatiSelezionati.length === 1 ? "slot" : "slot"} per inviare la richiesta.
        </div>
      )}
    </div>
  );
}
