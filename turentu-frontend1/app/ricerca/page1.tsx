"use client";

import { useState } from "react";
import { getCoordinates } from "@/utils/getCoordinates";

type Corsa = {
  id: string;
  veicolo: { modello: string; id?: number };
  autista: { nome: string; id?: number };
  slot_libero: boolean;
  distanzaKm: number;
  prezzo: number;
  corseCompatibili: any[];
  origine: string;
  destinazione: string;
  orario_inizio: string;
  orario_arrivo: string;
  durata_percorso_min: number;
};

export default function RicercaPage() {
  const [partenza, setPartenza] = useState("");
  const [arrivo, setArrivo] = useState("");
  const [datetime, setDatetime] = useState("");
  const [passeggeri, setPasseggeri] = useState(1);
  const [corse, setCorse] = useState<Corsa[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleCerca = async () => {
    setLoading(true);
    setError("");
    setCorse([]);

    try {
      const partenzaCoord = await getCoordinates(partenza);
      const arrivoCoord = await getCoordinates(arrivo);

      const res = await fetch("http://localhost:3001/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          coord: partenzaCoord,
          destinazione: arrivoCoord,
          arrivo_datetime: datetime,
          posti_richiesti: passeggeri,
          km: 0,
          tipo: "CORRENTE",
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || "Errore ricerca corse");
      }

      const data = await res.json();
      setCorse(data);
    } catch (err: any) {
      setError(err.message || "Errore durante la ricerca");
    } finally {
      setLoading(false);
    }
  };

  const handlePrenota = async (corsa: Corsa) => {
    try {
      if (corsa.slot_libero) {
        const res = await fetch("http://localhost:3001/pending", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slotId: corsa.id, posti_richiesti: passeggeri }),
        });
        if (!res.ok) throw new Error("Errore creazione pending");
        const data = await res.json();
        alert(`Pending creato: ${JSON.stringify(data)}`);
      } else {
        const res = await fetch("http://localhost:3001/prenotazione", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ corsa: corsa.id, clienteId: 1, posti_richiesti: passeggeri }),
        });
        if (!res.ok) throw new Error("Errore prenotazione");
        const data = await res.json();
        alert(`Prenotazione confermata: ${JSON.stringify(data)}`);
      }
    } catch (err: any) {
      alert(err.message || "Errore prenotazione");
    }
  };

  return (
    <div className="flex flex-col gap-6 p-4">
      <h1 className="text-3xl font-bold">Ricerca Disponibilità</h1>

      <div className="flex flex-col gap-2 max-w-md">
        <input
          type="text"
          placeholder="Partenza"
          value={partenza}
          onChange={(e) => setPartenza(e.target.value)}
          className="p-2 border rounded"
        />
        <input
          type="text"
          placeholder="Arrivo"
          value={arrivo}
          onChange={(e) => setArrivo(e.target.value)}
          className="p-2 border rounded"
        />
        <input
          type="datetime-local"
          value={datetime}
          onChange={(e) => setDatetime(e.target.value)}
          className="p-2 border rounded"
        />
        <input
          type="number"
          placeholder="Passeggeri"
          value={passeggeri}
          min={1}
          onChange={(e) => setPasseggeri(parseInt(e.target.value))}
          className="p-2 border rounded"
        />
        <button
          onClick={handleCerca}
          className="mt-2 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
        >
          {loading ? "Ricerca in corso..." : "Cerca"}
        </button>
        {error && <p className="text-red-600">{error}</p>}
      </div>

      {corse.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mt-4">
          {corse.map((corsa) => (
            <div key={corsa.id} className="p-4 bg-white rounded shadow flex flex-col gap-2">
              <h2 className="font-semibold">
                Veicolo: {corsa.veicolo?.modello ?? "Modello non disponibile"} -{" "}
                Autista: {corsa.autista?.nome ?? "Autista non assegnato"}
              </h2>
              <p>
                Origine → Destinazione: {corsa.origine ?? "-"} → {corsa.destinazione ?? "-"}
              </p>
              <p>Partenza: {corsa.orario_inizio ? new Date(corsa.orario_inizio).toLocaleString() : "-"}</p>
              <p>Arrivo: {corsa.orario_arrivo ? new Date(corsa.orario_arrivo).toLocaleString() : "-"}</p>
              <p>Durata: {corsa.durata_percorso_min ?? 0} min</p>
              <p>Distanza: {corsa.distanzaKm?.toFixed(2) ?? 0} km</p>
              <p>Prezzo: {corsa.prezzo?.toFixed(2) ?? 0} €</p>
              <p>
                Disponibile:{" "}
                {corsa.slot_libero ? (
                  <span className="text-green-600 font-semibold">Sì</span>
                ) : (
                  <span className="text-red-600 font-semibold">No</span>
                )}
              </p>
              <button
                onClick={() => handlePrenota(corsa)}
                className={`mt-2 px-3 py-1 rounded text-white transition ${
                  corsa.slot_libero ? "bg-blue-600 hover:bg-blue-700" : "bg-green-600 hover:bg-green-700"
                }`}
              >
                {corsa.slot_libero ? "Crea pending" : "Prenota corsa"}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
