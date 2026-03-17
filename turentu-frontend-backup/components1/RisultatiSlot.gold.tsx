import { useEffect, useState } from "react";

// Funzione di geocodifica inversa
const reverseGeocode = async (lat: number, lon: number): Promise<string> => {
  try {
    const response = await fetch(`http://localhost:3001/reverse-geocode?lat=${lat}&lon=${lon}`);
    if (!response.ok) {
      throw new Error('Errore nella geocodifica inversa');
    }
    const data = await response.json();
    return data.indirizzo || 'Indirizzo non disponibile';
  } catch (error) {
    console.error('Errore nella geocodifica inversa:', error);
    return 'Errore nella geocodifica inversa';
  }
};

interface Corsa {
  id: number;
  origine_lat: number;
  origine_lon: number;
  dest_lat: number;
  dest_lon: number;
  start_datetime?: string;
  arrivo_datetime?: string;
  stato?: string;
}

interface SlotUltra {
  veicolo_id: number;
  coord: { lat: number; lon: number };
  coordDestRichiesta?: { lat: number; lon: number };
  corseCompatibili: Corsa[];
  slot_libero: boolean;
  prezzo: number;
  stato: string;
}

interface Props {
  risultati: SlotUltra[];
}

export default function RisultatiSlot({ risultati }: Props) {
  const [localitaOrigine, setLocalitaOrigine] = useState<Map<string, string>>(new Map());
  const [localitaDestinazione, setLocalitaDestinazione] = useState<Map<string, string>>(new Map());

  // Funzione per ottenere la località
  const getLocalita = async (lat: number, lon: number, key: string) => {
    const localita = await reverseGeocode(lat, lon);  // Usa la geocodifica inversa
    if (key === 'origine') {
      setLocalitaOrigine(prev => new Map(prev.set(`${lat},${lon}`, localita)));
    } else {
      setLocalitaDestinazione(prev => new Map(prev.set(`${lat},${lon}`, localita)));
    }
  };

  useEffect(() => {
    // Chiamate per geocodificare tutte le coordinate
    risultati.forEach((r) => {
      // Origine
      if (r.coord) {
        getLocalita(r.coord.lat, r.coord.lon, 'origine');
      }
      // Destinazione
      if (r.coordDestRichiesta) {
        getLocalita(r.coordDestRichiesta.lat, r.coordDestRichiesta.lon, 'destinazione');
      }
      r.corseCompatibili.forEach((corsa) => {
        if (corsa.origine_lat && corsa.origine_lon) {
          getLocalita(corsa.origine_lat, corsa.origine_lon, 'origine');
        }
        if (corsa.dest_lat && corsa.dest_lon) {
          getLocalita(corsa.dest_lat, corsa.dest_lon, 'destinazione');
        }
      });
    });
  }, [risultati]);

  // Filtra solo gli slot che hanno corse compatibili o che sono liberi
  const risultatiFiltrati = risultati.filter((r) => r.corseCompatibili.length > 0 || r.slot_libero);

  return (
    <div className="max-w-xl mx-auto flex flex-col gap-4 mt-6">
      {risultatiFiltrati.map((r, i) => {
        const corsa = r.corseCompatibili[0]; // Consideriamo la prima corsa compatibile, se presente

        // Origine e destinazione, solo visualizzazione
        const origine = corsa ? { lat: corsa.origine_lat, lon: corsa.origine_lon } : r.coord;
        const destinazione = corsa
          ? { lat: corsa.dest_lat, lon: corsa.dest_lon }
          : r.coordDestRichiesta ?? undefined;

        const origineLocalita = origine ? localitaOrigine.get(`${origine.lat},${origine.lon}`) : "";
        const destinazioneLocalita = destinazione ? localitaDestinazione.get(`${destinazione.lat},${destinazione.lon}`) : "";

        return (
          <div
            key={`${r.veicolo_id}-${i}`}
            className={`border p-4 rounded shadow ${r.slot_libero ? "bg-green-50 dark:bg-green-900" : "bg-white dark:bg-zinc-900"}`}
          >
            <div className="flex justify-between items-center mb-2">
              <p className="font-semibold">Veicolo ID: {r.veicolo_id}</p>
              <span
                className={`px-2 py-1 text-xs font-semibold rounded ${
                  r.slot_libero
                    ? "bg-green-200 text-green-800 dark:bg-green-700 dark:text-green-100"
                    : "bg-blue-200 text-blue-800 dark:bg-blue-700 dark:text-blue-100"
                }`}
              >
                {r.slot_libero ? "Libero" : "Condiviso"}
              </span>
            </div>

            <p>
              Origine → Destinazione: {origineLocalita}
              {destinazioneLocalita ? ` → ${destinazioneLocalita}` : ""}
            </p>

            {corsa && (
              <>
                <p>Partenza: {corsa.start_datetime ?? "-"}</p>
                <p>
                  Arrivo: {corsa.arrivo_datetime ? new Date(corsa.arrivo_datetime).toLocaleString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  }) : "-"}
                  {!corsa.arrivo_datetime && (
                    <span className="ml-2 text-xs text-zinc-500">(stimato)</span>
                  )}
                </p>
              </>
            )}

            <p className="font-semibold">Prezzo: {r.prezzo.toFixed(2)} €</p>

            {/* Mostra corse compatibili se presenti */}
            {r.corseCompatibili.length > 0 && (
              <div className="mt-2">
                <div className="font-medium">Corse Compatibili:</div>
                <ul className="list-disc pl-5">
                  {r.corseCompatibili.map((corsa, index) => (
                    <li key={index}>
                      Corsa ID: {corsa.id} - Partenza: {corsa.start_datetime ?? "Non disponibile"}
                      {corsa.arrivo_datetime && (
                        <span> | Arrivo: {new Date(corsa.arrivo_datetime).toLocaleString()}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
