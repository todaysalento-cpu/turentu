// app/GoogleMapsLoader.tsx
'use client';

import { useEffect } from "react";

declare global {
  interface Window {
    google?: any;
    _googleMapsLoading?: boolean;
  }
}

export default function GoogleMapsLoader() {
  useEffect(() => {
    if (typeof window === "undefined") return;

    // Se Google Maps è già caricato o in caricamento, esci
    if (window.google || window._googleMapsLoading) return;

    window._googleMapsLoading = true;

    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY}&libraries=places`;
    script.async = true;
    script.defer = true;
    document.head.appendChild(script);

    script.onload = () => {
      console.log("✅ Google Maps API caricata");
      window._googleMapsLoading = false;
    };

    script.onerror = () => {
      console.error("❌ Errore caricamento Google Maps API");
      window._googleMapsLoading = false;
    };
  }, []);

  return null;
}
