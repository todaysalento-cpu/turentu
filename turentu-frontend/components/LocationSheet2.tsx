'use client';

import { usePlacesAutocomplete, PlaceResult } from "../hooks/usePlacesAutocomplete";
import { useState, useEffect, useRef } from "react";

interface Coord {
  lat: number;
  lon: number;
}

interface Props {
  query: string;
  setQuery: (q: string) => void;
  onClose: () => void;
  onSelect: (val: { nome: string; coord: Coord }) => void;
  isDestinazione?: boolean;
}

const POPULAR_LOCATIONS = [
  { description: "Roma, Italia", place_id: "pop_roma" },
  { description: "Milano, Italia", place_id: "pop_milano" },
  { description: "Firenze, Italia", place_id: "pop_firenze" },
];

export default function LocationSheet({
  query,
  setQuery,
  onClose,
  onSelect,
  isDestinazione = false,
}: Props) {
  const [isOpen, setIsOpen] = useState(true);
  const { results: autocompleteResults, loading } = usePlacesAutocomplete(query, isOpen);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleSelect = (place: PlaceResult) => {
    if (place.place_id.startsWith("pop_")) {
      onSelect({ nome: place.description, coord: { lat: 0, lon: 0 } });
      onClose();
      setIsOpen(false);
      return;
    }

    const geocoder = new (window as any).google.maps.Geocoder();
    geocoder.geocode({ placeId: place.place_id }, (res: any[], status: string) => {
      if (status !== "OK" || !res.length) {
        alert("Errore geocoding");
        return;
      }
      const loc = res[0].geometry.location;
      onSelect({ nome: place.description, coord: { lat: loc.lat(), lon: loc.lng() } });
      onClose();
      setIsOpen(false);
    });
  };

  const suggestions =
    query.length > 0 ? autocompleteResults.concat(POPULAR_LOCATIONS) : POPULAR_LOCATIONS;

  const placeholderText = isDestinazione ? "Dove vuoi andare?" : "Da dove parti?";

  return (
    <div ref={containerRef} className="flex flex-col w-full relative">
      {/* Input principale */}
      <input
        value={query}
        onFocus={() => setIsOpen(true)}
        onClick={() => setIsOpen(true)}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={placeholderText}
        className="
          w-full rounded-md p-2 mb-1
          border-2 border-[#ff3036]        /* bordo rosso spesso di default */
          focus:outline-none focus:border-1 focus:ring-2 focus:ring-[#ff3036] /* bordo ridotto a focus */
          transition
          bg-transparent                  /* nessuno sfondo */
        "
      />

      {/* Dropdown suggerimenti */}
      {isOpen && suggestions.length > 0 && (
        <div className="w-full max-h-72 overflow-y-auto mt-1 rounded-md">
          {loading && query.length > 0 && (
            <p className="p-2 text-gray-500 text-sm">Caricamento...</p>
          )}

          <ul className="flex flex-col">
            {suggestions.map((place) => (
              <li
                key={place.place_id}
                className="p-2 hover:bg-gray-100 cursor-pointer transition rounded"
                onClick={() => handleSelect(place)}
              >
                {place.description}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}