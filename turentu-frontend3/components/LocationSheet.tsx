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
  { description: "Roma, Italia", place_id: "pop_roma", coord: { lat: 41.9028, lon: 12.4964 } },
  { description: "Milano, Italia", place_id: "pop_milano", coord: { lat: 45.4642, lon: 9.1900 } },
  { description: "Firenze, Italia", place_id: "pop_firenze", coord: { lat: 43.7696, lon: 11.2558 } },
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
      // Usa le coordinate reali
      onSelect({ nome: place.description, coord: (place as any).coord });
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

  // 🔹 Mostra popolari solo se query vuota
  const suggestions = query.length > 0 ? autocompleteResults : POPULAR_LOCATIONS;

  const placeholderText = isDestinazione ? "Dove vuoi andare?" : "Da dove parti?";

  const inputClasses = `
    w-full rounded-md
    bg-gray-100 dark:bg-gray-800 dark:text-slate-100
    p-2 mb-1
    focus:outline-none focus:ring-2 focus:ring-[#ff3036]
    transition-colors duration-200
  `;

  const suggestionClasses = `
    p-2 cursor-pointer rounded hover:bg-gray-200 dark:hover:bg-gray-700
    transition-colors duration-150
  `;

  const dropdownClasses = `
    w-full max-h-72 overflow-y-auto mt-1 rounded-md
    bg-white dark:bg-gray-800
  `;

  return (
    <div ref={containerRef} className="flex flex-col w-full relative">
      <input
        value={query}
        onFocus={() => setIsOpen(true)}
        onClick={() => setIsOpen(true)}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={placeholderText}
        className={inputClasses}
      />

      {isOpen && suggestions.length > 0 && (
        <div className={dropdownClasses}>
          {loading && query.length > 0 && (
            <p className="p-2 text-gray-500 dark:text-gray-400 text-sm">Caricamento...</p>
          )}

          <ul className="flex flex-col">
            {suggestions.map((place) => (
              <li
                key={place.place_id}
                className={suggestionClasses}
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