import { servizioIconMap } from "../utils/serviziIcons"; // assicurati che punti al file corretto

interface Risultato {
  id: string;
  tipo: "slot" | "corsa";
  modello: string;
  servizi: string[];
  coordOrigine: { lat: number; lon: number };
  coordDestinazione: { lat: number; lon: number };
  oraPartenza: string | Date;
  oraArrivo: string | Date;
  distanzaKm: number;
  prezzo: number;
  stato: string;
  postiPrenotati?: number;
  primoPosto?: number;
}

interface Props {
  risultati: Risultato[];
}

export default function RisultatiSlot({ risultati }: any) {
  console.log("RISULTATI:", risultati); // <-- debug completo
  return (
    <div className="flex flex-col gap-4">
      {risultati.map((r: any) => {
        console.log("SERVIZI DI", r.modello, ":", r.servizi); // <-- controlla qui

        return (
          <div key={r.id} className="border p-4 rounded shadow-md">
            <h2 className="font-bold text-lg">{r.modello}</h2>

            <p>
              <strong>Origine:</strong> {r.coordOrigine.lat}, {r.coordOrigine.lon} <br />
              <strong>Destinazione:</strong> {r.coordDestinazione.lat}, {r.coordDestinazione.lon}
            </p>

            <p>
              <strong>Partenza:</strong> {new Date(r.oraPartenza).toLocaleString()} <br />
              <strong>Arrivo:</strong> {new Date(r.oraArrivo).toLocaleString()}
            </p>

            <p>
              <strong>Distanza:</strong> {r.distanzaKm?.toFixed(1)} km <br />
              <strong>Prezzo:</strong> {r.prezzo?.toFixed(2)} €
            </p>

            {r.servizi && r.servizi.length > 0 && (
              <p>
                <strong>Servizi:</strong>{" "}
                {r.servizi.map((s: any, i: number) => (
                  <span key={i} className="inline-flex items-center gap-1 mr-2">
                    {s}
                  </span>
                ))}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
