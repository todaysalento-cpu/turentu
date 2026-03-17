// utils/getCoordinates.ts
export async function getCoordinates(address: string) {
  if (!address || address.trim() === "") {
    throw new Error("Indirizzo non valido");
  }

  const baseUrl =
    typeof window === "undefined"
      ? "http://127.0.0.1:3001"
      : "http://localhost:3001";

  const url = `${baseUrl}/geocode?address=${encodeURIComponent(address)}`;

  try {
    const res = await fetch(url);

    if (!res.ok) {
      const text = await res.text();
      console.error("GEOCODE ERROR:", res.status, text);
      if (res.status === 404) throw new Error("Indirizzo non trovato");
      throw new Error("Errore durante il geocoding");
    }

    const data = await res.json();

    if (!data || typeof data.lat !== "number" || typeof data.lon !== "number") {
      throw new Error("Geocoding ritorna dati invalidi");
    }

    return { lat: data.lat, lon: data.lon };
  } catch (err: any) {
    console.error("❌ Geocoding fallito:", err.message || err);
    throw new Error(err.message || "Geocoding fallito");
  }
}
