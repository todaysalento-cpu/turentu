"use client";

import { useState, useEffect } from "react";
import RisultatiSlot from "../components/RisultatiSlot";

export default function Ricerca() {
  const [risultati, setRisultati] = useState([]);

  useEffect(() => {
    async function fetchData() {
      const res = await fetch("http://localhost:3001/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          posti_richiesti: 1,
          coord: { lat: 41.891, lon: 12.495 },
          destinazione: { lat: 41.895, lon: 12.5 },
          km: 5,
          arrivo_datetime: new Date().toISOString(),
        }),
      });
      const data = await res.json();
      setRisultati(data);
    }
    fetchData();
  }, []);

  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold mb-4">Risultati Slot e Corse</h1>
      <RisultatiSlot risultati={risultati} />
    </div>
  );
}
