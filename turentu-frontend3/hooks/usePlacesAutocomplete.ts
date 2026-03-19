// hooks/usePlacesAutocomplete.ts
import { useState, useEffect } from "react";

export interface PlaceResult {
  description: string;
  place_id: string;
}

export function usePlacesAutocomplete(query: string) {
  const [results, setResults] = useState<PlaceResult[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!query || query.length < 3) {
      setResults([]);
      setLoading(false);
      return;
    }

    if (!(window as any).google?.maps?.places) {
      console.warn("Google Maps API non ancora caricata");
      setResults([]);
      setLoading(false);
      return;
    }

    let active = true;
    setLoading(true);

    const service = new window.google.maps.places.AutocompleteService();
    service.getPlacePredictions(
      { input: query, componentRestrictions: { country: "it" } },
      (predictions) => {
        if (!active) return;
        setResults(
          (predictions || []).map((p) => ({
            description: p.description,
            place_id: p.place_id,
          }))
        );
        setLoading(false);
      }
    );

    return () => { active = false; };
  }, [query]);

  return { results, loading };
}
