// app/GoogleMapsLoader.tsx
'use client';

import { useEffect } from "react";

export default function GoogleMapsLoader() {
  useEffect(() => {
    if (typeof window === "undefined") return;

    // Se Google Maps non è già caricato
    if (!(window as any).google) {
      const script = document.createElement("script");
      script.src = `https://maps.googleapis.com/maps/api/js?key=${process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY}&libraries=places`;
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);

      script.onload = () => console.log("✅ Google Maps API caricata");
      script.onerror = () => console.error("❌ Errore caricamento Google Maps API");
    }
  }, []);

  return null;
}
