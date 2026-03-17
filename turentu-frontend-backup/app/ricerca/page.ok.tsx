"use client"; // Aggiungi questa direttiva per farlo diventare un Client Component

import { useState } from "react";
import RisultatiSlot from "../../components/RisultatiSlot";

// Funzione per geocodifica
const geocode = async (indirizzo: string) => {
  if (!indirizzo.trim()) throw new Error("Indirizzo vuoto");
  const res = await fetch(
    `http://localhost:3001/geocode?address=${encodeURIComponent(indirizzo)}`
  );
  if (!res.ok) throw new Error(`Impossibile geocodificare: ${indirizzo}`);
  const data = await res.json();
  return { lat: Number(data.lat), lon: Number(data.lon) };
};

const Ricerca = () => {
  const [origine, setOrigine] = useState("");
  const [destinazione, setDestinazione] = useState("");
  const [data, setData] = useState("");
  const [passeggeri, setPasseggeri] = useState(1);

  const [risultati, setRisultati] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [errore, setErrore] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setErrore(null);

    try {
      // Geocodifica delle destinazioni
      const origineCoord = await geocode(origine);
      const destinazioneCoord = await geocode(destinazione);

      const bodyRequest = {
        coord: origineCoord,
        coordDest: destinazioneCoord,
        arrivo_datetime: data,
      };

      const res = await fetch("http://localhost:3001/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bodyRequest),
      });

      if (!res.ok) throw new Error("Errore nel recupero dei risultati");

      const result = await res.json();

      // Rimuovi la parte che aggiunge coordDestRichiesta e usa direttamente i risultati ricevuti
      setRisultati(result);
    } catch (err: any) {
      console.error("Errore nella ricerca:", err);
      setErrore(err.message ?? "Errore nella ricerca");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-black py-8 px-4">
      <h1 className="text-3xl font-bold text-center mb-6 text-black dark:text-zinc-50">
        Ricerca disponibilità
      </h1>

      <form
        onSubmit={handleSubmit}
        className="max-w-xl mx-auto flex flex-col gap-4"
      >
        <input
          type="text"
          placeholder="Origine"
          value={origine}
          onChange={(e) => setOrigine(e.target.value)}
          required
          className="border px-3 py-2 rounded w-full"
        />
        <input
          type="text"
          placeholder="Destinazione"
          value={destinazione}
          onChange={(e) => setDestinazione(e.target.value)}
          required
          className="border px-3 py-2 rounded w-full"
        />
        <input
          type="datetime-local"
          value={data}
          onChange={(e) => setData(e.target.value)}
          required
          className="border px-3 py-2 rounded w-full"
        />
        <input
          type="number"
          min={1}
          value={passeggeri}
          onChange={(e) => setPasseggeri(Number(e.target.value))}
          required
          className="border px-3 py-2 rounded w-full"
        />
        <button
          type="submit"
          className="bg-blue-600 text-white px-6 py-3 rounded hover:bg-blue-700 transition"
        >
          Cerca
        </button>
      </form>

      {loading && <p className="text-center mt-4">Caricamento…</p>}
      {errore && <p className="text-center text-red-500 mt-4">{errore}</p>}
      {!loading && !errore && risultati.length > 0 && (
        <RisultatiSlot risultati={risultati} />
      )}
      {!loading && !errore && risultati.length === 0 && (
        <p className="text-center mt-4">Nessun risultato disponibile</p>
      )}
    </div>
  );
};

export default Ricerca;
